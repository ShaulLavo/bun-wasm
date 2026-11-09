//! Resource-aware admission through the real group allocator and backing budget.
use super::*;
use std::sync::Barrier;
use std::thread;

const PAGE: u64 = PAGE_BYTES as u64;

fn group_with(maximum_pages: u32, budget: GroupBackingBudget) -> MemoryGroup {
    let policy = GroupPolicy {
        maximum_pages,
        ..GroupPolicy::default()
    };
    MemoryGroup::new(&Engine::default(), policy, budget).unwrap()
}

fn budget_of(pages: u64) -> GroupBackingBudget {
    GroupBackingBudget::new(pages * PAGE)
}

fn launch(group: &MemoryGroup, pid: u32) -> MemberLease {
    group.reserve(pid).unwrap().launch()
}

/// What a refused admission must leave untouched.
fn resources(group: &MemoryGroup, budget: &GroupBackingBudget) -> (usize, u64, u64, u64) {
    let snapshot = group.snapshot();
    (
        snapshot.regions,
        snapshot.committed_bytes,
        snapshot.free_bytes,
        budget.committed_bytes(),
    )
}

#[test]
fn a_maximum_that_fits_keeps_its_whole_range_and_grows_to_it() {
    let group = group_with(16384, GroupBackingBudget::default());
    let member = launch(&group, 1);
    let memory = NestedMemory::new(&member, 1, 2048).unwrap();
    assert_eq!(memory.reserved_bytes(), 2048 * PAGE);
    assert_eq!(memory.maximum(), 2048);
    group.store32(memory.base(), 77).unwrap();
    assert_eq!(memory.grow(2047), Ok(1));
    assert_eq!(memory.pages(), 2048);
    assert_eq!(group.load32(memory.base()), Ok(77));
    let last_word = memory.base() + 2047 * PAGE_BYTES + 65532;
    assert_eq!(group.load32(last_word), Ok(0));
    drop(memory);
    member.physical_stopped();
}

#[test]
fn declared_maximums_past_the_signed_limit_fall_back_and_stay_declared() {
    let group = group_with(16384, GroupBackingBudget::default());
    let member = launch(&group, 1);
    for maximum in [32768, 65535, 65536] {
        let memory = NestedMemory::new(&member, 1, maximum).unwrap();
        assert_eq!(memory.maximum(), maximum);
        assert_eq!(memory.reserved_bytes(), 1025 * PAGE);
        assert_eq!(memory.pages(), 1);
    }
    member.physical_stopped();
}

#[test]
fn a_huge_maximum_that_fits_is_capped_only_by_the_signed_length() {
    let group = group_with(65536, GroupBackingBudget::default());
    let member = launch(&group, 1);
    let memory = NestedMemory::new(&member, 1, 65536).unwrap();
    assert_eq!(memory.maximum(), 65536);
    assert_eq!(
        memory.reserved_bytes(),
        u64::from(MAX_RESERVATION_PAGES) * PAGE
    );
    drop(memory);
    member.physical_stopped();
}

#[test]
fn the_largest_reservation_is_admitted_and_the_next_is_a_resource_refusal() {
    let budget = GroupBackingBudget::default();
    let group = group_with(65536, budget.clone());
    let member = launch(&group, 1);
    for (initial, maximum) in [
        (32768, 32768),
        (32768, 65536),
        (65535, 65535),
        (65536, 65536),
    ] {
        let before = resources(&group, &budget);
        assert_eq!(
            NestedMemory::new(&member, initial, maximum).err(),
            Some(Errno::NoMem)
        );
        assert_eq!(resources(&group, &budget), before);
    }
    let largest = NestedMemory::new(&member, 32767, 32767).unwrap();
    assert_eq!(largest.reserved_bytes(), 32767 * PAGE);
    assert_eq!(budget.committed_bytes(), 32768 * PAGE);
    drop(largest);
    member.physical_stopped();
}

#[test]
fn invalid_descriptors_are_refused_before_any_arithmetic_or_resource_change() {
    let budget = GroupBackingBudget::default();
    let group = group_with(16384, budget.clone());
    let member = launch(&group, 1);
    let before = resources(&group, &budget);
    for (initial, maximum) in [
        (2, 1),
        (1, 65537),
        (65537, 65537),
        (1, u32::MAX),
        (u32::MAX, u32::MAX),
    ] {
        assert_eq!(
            NestedMemory::new(&member, initial, maximum).err(),
            Some(Errno::Inval)
        );
    }
    assert_eq!(resources(&group, &budget), before);
    member.physical_stopped();
}

#[test]
fn optional_headroom_yields_and_never_refuses_initial_bytes_that_fit() {
    let budget = GroupBackingBudget::default();
    let group = group_with(2048, budget.clone());
    let member = launch(&group, 1);
    assert_eq!(group_grow(&member, 547), 1);
    // 1500 pages remain, so the 100 spare pages lend half.
    let first = NestedMemory::new(&member, 1400, 65536).unwrap();
    assert_eq!(first.reserved_bytes(), 1450 * PAGE);
    let second = NestedMemory::new(&member, 40, 65536).unwrap();
    assert_eq!(second.reserved_bytes(), 45 * PAGE);
    // No optional room is left at all, and the required bytes still fit exactly.
    let third = NestedMemory::new(&member, 5, 65536).unwrap();
    assert_eq!(third.reserved_bytes(), 5 * PAGE);
    let before = resources(&group, &budget);
    assert_eq!(
        NestedMemory::new(&member, 1, 65536).err(),
        Some(Errno::NoMem)
    );
    assert_eq!(resources(&group, &budget), before);
    drop((first, second, third));
    member.physical_stopped();
}

#[test]
fn the_fallback_preference_applies_only_when_the_maximum_cannot_fit() {
    let group = group_with(16384, GroupBackingBudget::default());
    let member = launch(&group, 1);
    let fallback = NestedMemory::new(&member, 100, 65536).unwrap();
    assert_eq!(
        fallback.reserved_bytes(),
        u64::from(100 + PREFERRED_FALLBACK_HEADROOM_PAGES) * PAGE
    );
    let full = NestedMemory::new(&member, 100, 2 + PREFERRED_FALLBACK_HEADROOM_PAGES * 3).unwrap();
    assert_eq!(
        full.reserved_bytes(),
        u64::from(2 + PREFERRED_FALLBACK_HEADROOM_PAGES * 3) * PAGE
    );
    drop((fallback, full));
    member.physical_stopped();
}

#[test]
fn a_fixed_memory_never_gets_headroom() {
    let group = group_with(16384, GroupBackingBudget::default());
    let member = launch(&group, 1);
    let memory = NestedMemory::new(&member, 5, 5).unwrap();
    assert_eq!(memory.reserved_bytes(), 5 * PAGE);
    assert_eq!(memory.grow(1), Err(Errno::NoMem));
    assert_eq!(memory.grow(0), Ok(5));
    drop(memory);
    member.physical_stopped();
}

/// Holes of 300 pages at pages 1 and 311, separated and closed off by live regions.
struct Fragmented {
    group: MemoryGroup,
    member: MemberLease,
    budget: GroupBackingBudget,
    _separators: [NestedMemory; 2],
    first_hole: u32,
    second_hole: u32,
}

fn fragmented(maximum_pages: u32) -> Fragmented {
    let budget = GroupBackingBudget::default();
    let group = group_with(maximum_pages, budget.clone());
    let member = launch(&group, 1);
    let first = NestedMemory::new(&member, 300, 300).unwrap();
    let separator = NestedMemory::new(&member, 10, 10).unwrap();
    let second = NestedMemory::new(&member, 300, 300).unwrap();
    let end = NestedMemory::new(&member, 10, 10).unwrap();
    let (first_hole, second_hole) = (first.base(), second.base());
    group.store32(first_hole, 99).unwrap();
    drop((first, second));
    Fragmented {
        group,
        member,
        budget,
        _separators: [separator, end],
        first_hole,
        second_hole,
    }
}

#[test]
fn separated_holes_are_never_summed_into_one_reservation() {
    let setup = fragmented(621);
    assert_eq!(setup.group.snapshot().free_bytes, 600 * PAGE);
    let before = resources(&setup.group, &setup.budget);
    // Aggregate free bytes would cover this, and the tail is closed.
    assert_eq!(
        NestedMemory::new(&setup.member, 500, 500).err(),
        Some(Errno::NoMem)
    );
    assert_eq!(
        NestedMemory::new(&setup.member, 500, 65536).err(),
        Some(Errno::NoMem)
    );
    assert_eq!(resources(&setup.group, &setup.budget), before);
    setup.member.physical_stopped();
}

#[test]
fn a_hole_is_reused_without_a_new_charge_and_rezeroed() {
    let setup = fragmented(621);
    let committed = setup.group.snapshot().committed_bytes;
    let reused = NestedMemory::new(&setup.member, 300, 300).unwrap();
    assert_eq!(reused.base(), setup.first_hole);
    assert_eq!(setup.group.load32(reused.base()), Ok(0));
    let growing = NestedMemory::new(&setup.member, 1, 300).unwrap();
    assert_eq!(growing.base(), setup.second_hole);
    assert_eq!(growing.reserved_bytes(), 300 * PAGE);
    assert_eq!(setup.group.snapshot().committed_bytes, committed);
    assert_eq!(setup.group.snapshot().free_bytes, 0);
    drop((reused, growing));
    setup.member.physical_stopped();
}

#[test]
fn a_range_no_hole_can_hold_comes_from_the_open_tail() {
    let setup = fragmented(2000);
    let memory = NestedMemory::new(&setup.member, 500, 500).unwrap();
    assert_eq!(memory.base(), 621 * PAGE_BYTES);
    assert_eq!(setup.group.snapshot().free_bytes, 600 * PAGE);
    drop(memory);
    setup.member.physical_stopped();
}

#[test]
fn a_tail_hole_joins_new_growth_and_only_the_growth_is_charged() {
    // Neither the 100-page hole nor the 60 chargeable pages can hold 150 pages alone.
    let budget = budget_of(171);
    let group = group_with(1000, budget.clone());
    let member = launch(&group, 1);
    let _keep = NestedMemory::new(&member, 10, 10).unwrap();
    let tail = NestedMemory::new(&member, 100, 100).unwrap();
    let base = tail.base();
    group.store32(base, 55).unwrap();
    drop(tail);
    assert_eq!(group.snapshot().committed_bytes, 111 * PAGE);
    let joined = NestedMemory::new(&member, 150, 150).unwrap();
    assert_eq!(joined.base(), base);
    assert_eq!(joined.reserved_bytes(), 150 * PAGE);
    assert_eq!(group.snapshot().committed_bytes, 161 * PAGE);
    assert_eq!(group.snapshot().free_bytes, 0);
    assert_eq!(group.load32(base), Ok(0));
    drop(joined);
    member.physical_stopped();
}

#[test]
fn the_backing_budget_limits_the_tail_but_not_reusable_holes() {
    let budget = budget_of(11);
    let group = group_with(16384, budget.clone());
    let member = launch(&group, 1);
    let spent = NestedMemory::new(&member, 1, 2048).unwrap();
    // Ten pages remain chargeable, so optional room stops at half of the nine spare.
    assert_eq!(spent.reserved_bytes(), 5 * PAGE);
    let rest = NestedMemory::new(&member, 5, 5).unwrap();
    assert_eq!(budget.committed_bytes(), 11 * PAGE);
    assert_eq!(NestedMemory::new(&member, 1, 1).err(), Some(Errno::NoMem));
    drop(rest);
    let reused = NestedMemory::new(&member, 4, 4).unwrap();
    assert_eq!(budget.committed_bytes(), 11 * PAGE);
    assert_eq!(reused.reserved_bytes(), 4 * PAGE);
    drop((spent, reused));
    member.physical_stopped();
}

fn spawn_exhausting_member<'scope>(
    scope: &'scope thread::Scope<'scope, '_>,
    member: &'scope MemberLease,
    start: &'scope Barrier,
) -> thread::ScopedJoinHandle<'scope, Vec<NestedMemory>> {
    scope.spawn(move || {
        start.wait();
        std::iter::from_fn(|| NestedMemory::new(member, 1, 1).ok()).collect()
    })
}

#[test]
fn two_groups_on_one_budget_never_charge_past_its_limit() {
    let budget = budget_of(64);
    let groups = [
        group_with(4096, budget.clone()),
        group_with(4096, budget.clone()),
    ];
    let members = [launch(&groups[0], 1), launch(&groups[1], 2)];
    let start = Barrier::new(2);
    let admitted: usize = thread::scope(|scope| {
        let workers = members
            .each_ref()
            .map(|member| spawn_exhausting_member(scope, member, &start));
        let held = workers.map(|worker| worker.join().unwrap());
        let count = held.iter().map(Vec::len).sum();
        drop(held);
        count
    });
    assert_eq!(admitted, 62);
    assert_eq!(budget.committed_bytes(), 64 * PAGE);
    assert_eq!(budget.peak_bytes(), 64 * PAGE);
    let [first, second] = members;
    first.physical_stopped();
    second.physical_stopped();
}

fn reserved_in_order(first: u32, second: u32) -> (u64, u64) {
    let group = group_with(2000, GroupBackingBudget::default());
    let member = launch(&group, 1);
    let a = NestedMemory::new(&member, 1, first).unwrap();
    let b = NestedMemory::new(&member, 1, second).unwrap();
    let reserved = (a.reserved_bytes() / PAGE, b.reserved_bytes() / PAGE);
    drop((a, b));
    member.physical_stopped();
    reserved
}

#[test]
fn admission_is_first_come_and_both_orders_still_construct() {
    assert_eq!(reserved_in_order(1500, 900), (1500, 250));
    assert_eq!(reserved_in_order(900, 1500), (900, 550));
}

#[test]
fn a_full_reservation_that_fits_can_refuse_a_later_member() {
    let group = group_with(2000, GroupBackingBudget::default());
    let parent = launch(&group, 1);
    let worker = launch(&group, 2);
    let memory = NestedMemory::new(&parent, 1, 1999).unwrap();
    assert_eq!(memory.reserved_bytes(), 1999 * PAGE);
    assert_eq!(group_grow(&worker, 1), Errno::NoMem.result());
    drop(memory);
    worker.physical_stopped();
    parent.physical_stopped();
}

#[test]
fn a_fallback_reservation_leaves_room_for_later_members() {
    let group = group_with(2000, GroupBackingBudget::default());
    let parent = launch(&group, 1);
    let worker = launch(&group, 2);
    let memory = NestedMemory::new(&parent, 1, 65536).unwrap();
    assert_eq!(memory.reserved_bytes(), 1000 * PAGE);
    assert!(group_grow(&worker, 999) > 0);
    drop(memory);
    worker.physical_stopped();
    parent.physical_stopped();
}

fn spawn_growing_member<'scope>(
    scope: &'scope thread::Scope<'scope, '_>,
    member: &'scope MemberLease,
    start: &'scope Barrier,
) -> thread::ScopedJoinHandle<'scope, NestedMemory> {
    scope.spawn(move || {
        start.wait();
        let memory = NestedMemory::new(member, 2, 20).unwrap();
        assert_eq!(memory.grow(3), Ok(2));
        memory
    })
}

#[test]
fn competing_members_get_disjoint_zeroed_ranges() {
    let group = group_with(4096, GroupBackingBudget::default());
    let members: Vec<_> = (1..=8).map(|pid| launch(&group, pid)).collect();
    let start = Barrier::new(members.len());
    let mut held: Vec<NestedMemory> = thread::scope(|scope| {
        let workers: Vec<_> = members
            .iter()
            .map(|member| spawn_growing_member(scope, member, &start))
            .collect();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect()
    });
    held.sort_by_key(NestedMemory::base);
    for pair in held.windows(2) {
        assert!(u64::from(pair[0].base()) + pair[0].reserved_bytes() <= u64::from(pair[1].base()));
    }
    for memory in &held {
        assert_eq!(group.load32(memory.base()), Ok(0));
    }
    drop(held);
    for member in members {
        member.physical_stopped();
    }
}

#[test]
fn zero_page_memories_keep_distinct_identities_and_their_declared_limit() {
    let budget = GroupBackingBudget::default();
    let group = group_with(16384, budget.clone());
    let member = launch(&group, 1);
    let before = budget.committed_bytes();
    let first = NestedMemory::new(&member, 0, 0).unwrap();
    let second = NestedMemory::new(&member, 0, 0).unwrap();
    assert_ne!(first.base(), second.base());
    assert_eq!(first.reserved_bytes(), PAGE);
    assert_eq!(first.len(), 0);
    assert_eq!(first.maximum(), 0);
    assert_eq!(budget.committed_bytes() - before, 2 * PAGE);
    assert_eq!(first.grow(1), Err(Errno::NoMem));
    assert_eq!(first.grow(0), Ok(0));
    assert_eq!(first.pages(), 0);
    let growing = NestedMemory::new(&member, 0, 3).unwrap();
    assert_eq!(growing.reserved_bytes(), 3 * PAGE);
    assert_eq!(growing.grow(1), Ok(0));
    assert_eq!(group.load32(growing.base()), Ok(0));
    let declared = NestedMemory::new(&member, 0, 65536).unwrap();
    assert_eq!(declared.reserved_bytes(), 1025 * PAGE);
    assert_eq!(declared.grow(1), Ok(0));
    drop((first, second, growing, declared));
    member.physical_stopped();
}

#[test]
fn an_overshoot_with_room_left_changes_nothing_and_a_smaller_growth_works() {
    let group = group_with(16384, GroupBackingBudget::default());
    let member = launch(&group, 1);
    for (maximum, overshoot) in [(10, 20), (65536, 2000)] {
        let memory = NestedMemory::new(&member, 1, maximum).unwrap();
        group.store32(memory.base(), 41).unwrap();
        let reserved = memory.reserved_bytes();
        assert_eq!(memory.grow(overshoot), Err(Errno::NoMem));
        assert_eq!(memory.pages(), 1);
        assert_eq!(memory.len(), PAGE);
        assert_eq!(memory.reserved_bytes(), reserved);
        assert_eq!(group.load32(memory.base()), Ok(41));
        assert_eq!(memory.grow(2), Ok(1));
        assert_eq!(memory.pages(), 3);
        assert_eq!(group.load32(memory.base()), Ok(41));
        assert_eq!(group.load32(memory.base() + 2 * PAGE_BYTES), Ok(0));
    }
    member.physical_stopped();
}

#[test]
fn filling_the_bound_refuses_the_next_page_and_zero_growth_is_separate() {
    let group = group_with(16384, GroupBackingBudget::default());
    let member = launch(&group, 1);
    // One memory bounded by its declared maximum, one by a smaller selected reservation.
    for (maximum, bound) in [(10, 10), (65536, 1025)] {
        let memory = NestedMemory::new(&member, 1, maximum).unwrap();
        assert_eq!(memory.grow(bound - 1), Ok(1));
        assert_eq!(memory.grow(1), Err(Errno::NoMem));
        assert_eq!(memory.grow(u32::MAX), Err(Errno::NoMem));
        assert_eq!(memory.grow(0), Ok(bound));
        assert_eq!(memory.pages(), bound);
    }
    member.physical_stopped();
}

#[test]
fn attached_members_inherit_the_selected_range_unchanged() {
    let group = group_with(16384, GroupBackingBudget::default());
    let sender = launch(&group, 1);
    let receiver = launch(&group, 2);
    let memory = NestedMemory::new(&sender, 1, 65536).unwrap();
    let token = memory.publish().unwrap();
    let attached = NestedMemory::attach(&receiver, token).unwrap();
    assert_eq!(attached.base(), memory.base());
    assert_eq!(attached.maximum(), 65536);
    assert_eq!(attached.reserved_bytes(), 1025 * PAGE);
    assert_eq!(attached.grow(2000), Err(Errno::NoMem));
    assert_eq!(attached.grow(3), Ok(1));
    assert_eq!(memory.pages(), 4);
    assert_eq!(memory.grow(1022), Err(Errno::NoMem));
    assert_eq!(memory.grow(1021), Ok(4));
    assert_eq!(attached.grow(1), Err(Errno::NoMem));
    drop((attached, memory));
    receiver.physical_stopped();
    sender.physical_stopped();
}

#[test]
fn accounting_keeps_visible_reserved_free_physical_and_peak_separate() {
    let budget = GroupBackingBudget::default();
    let group = group_with(16384, budget.clone());
    let member = launch(&group, 1);
    let memory = NestedMemory::new(&member, 1, 65536).unwrap();
    assert_eq!(memory.len(), PAGE);
    assert_eq!(memory.reserved_bytes(), 1025 * PAGE);
    assert_eq!(group.snapshot().free_bytes, 0);
    assert_eq!(group.snapshot().committed_bytes, 1026 * PAGE);
    assert_eq!(budget.committed_bytes(), 1026 * PAGE);
    assert_eq!(budget.peak_bytes(), 1026 * PAGE);
    assert_eq!(memory.grow(4), Ok(1));
    assert_eq!(memory.len(), 5 * PAGE);
    assert_eq!(memory.reserved_bytes(), 1025 * PAGE);
    assert_eq!(budget.committed_bytes(), 1026 * PAGE);
    drop(memory);
    member.physical_stopped();
}

#[test]
fn releasing_a_region_frees_its_chunk_but_does_not_refund_the_high_water_charge() {
    let budget = GroupBackingBudget::default();
    let group = group_with(2000, budget.clone());
    let member = launch(&group, 1);
    let memory = NestedMemory::new(&member, 1, 40).unwrap();
    let token = memory.publish().unwrap();
    drop(memory);
    // The directory entry alone still holds the region out of the free list.
    assert_eq!(group.snapshot().regions, 1);
    assert_eq!(group.snapshot().free_bytes, 0);
    withdraw(&member, token).unwrap();
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().free_bytes, 40 * PAGE);
    assert_eq!(group.snapshot().committed_bytes, 41 * PAGE);
    assert_eq!(budget.committed_bytes(), 41 * PAGE);
    assert_eq!(budget.peak_bytes(), 41 * PAGE);
    member.physical_stopped();
    assert_eq!(budget.committed_bytes(), 41 * PAGE);
}

#[test]
fn a_failed_member_leaves_a_live_receivers_bytes_and_the_budget_ends_with_the_last_user() {
    let budget = GroupBackingBudget::default();
    let group = group_with(2000, budget.clone());
    let sender = launch(&group, 1);
    let receiver = launch(&group, 2);
    let memory = NestedMemory::new(&sender, 1, 40).unwrap();
    group.store32(memory.base(), 7).unwrap();
    let token = memory.publish().unwrap();
    let attached = NestedMemory::attach(&receiver, token).unwrap();
    // The sender fails while it still holds its lease.
    sender.physical_stopped();
    assert_eq!(group.snapshot().regions, 1);
    assert_eq!(group.snapshot().holds, 1);
    assert_eq!(group.load32(attached.base()), Ok(7));
    assert_eq!(attached.grow(2), Ok(1));
    assert_eq!(attached.reserved_bytes(), 40 * PAGE);
    receiver.physical_stopped();
    let snapshot = group.snapshot();
    assert_eq!(
        (snapshot.members, snapshot.regions, snapshot.holds),
        (0, 0, 0)
    );
    assert_eq!(snapshot.published, 0);
    assert_eq!(budget.committed_bytes(), 41 * PAGE);
    // A raw Store user keeps the backing charged after the group and its leases are gone.
    let store_user = group.memory_lease();
    drop((memory, attached));
    drop(group);
    assert_eq!(budget.committed_bytes(), 41 * PAGE);
    drop(store_user);
    assert_eq!(budget.committed_bytes(), 0);
    assert_eq!(budget.peak_bytes(), 41 * PAGE);
}

fn fail_next_tail_growth(group: &MemoryGroup) {
    group
        .inner
        .fail_next_tail_growth
        .store(true, Ordering::SeqCst);
}

#[test]
fn a_failed_growth_with_optional_room_retries_at_exactly_the_required_size() {
    let budget = GroupBackingBudget::default();
    let group = group_with(16384, budget.clone());
    let member = launch(&group, 1);
    fail_next_tail_growth(&group);
    let memory = NestedMemory::new(&member, 1, 65536).unwrap();
    assert_eq!(memory.reserved_bytes(), PAGE);
    assert_eq!(budget.committed_bytes(), 2 * PAGE);
    drop(memory);
    member.physical_stopped();
}

#[test]
fn a_failed_required_growth_leaks_no_charge_and_the_next_attempt_works() {
    let budget = GroupBackingBudget::default();
    let group = group_with(16384, budget.clone());
    let member = launch(&group, 1);
    let before = resources(&group, &budget);
    fail_next_tail_growth(&group);
    assert_eq!(NestedMemory::new(&member, 3, 3).err(), Some(Errno::NoMem));
    assert_eq!(resources(&group, &budget), before);
    let memory = NestedMemory::new(&member, 3, 3).unwrap();
    assert_eq!(memory.pages(), 3);
    drop(memory);
    member.physical_stopped();
}

#[test]
fn a_failed_tail_join_keeps_the_hole_and_returns_the_charge() {
    let budget = GroupBackingBudget::default();
    let group = group_with(1000, budget.clone());
    let member = launch(&group, 1);
    let _keep = NestedMemory::new(&member, 10, 10).unwrap();
    drop(NestedMemory::new(&member, 100, 100).unwrap());
    let before = resources(&group, &budget);
    assert_eq!(group.snapshot().free_bytes, 100 * PAGE);
    fail_next_tail_growth(&group);
    assert_eq!(
        NestedMemory::new(&member, 150, 150).err(),
        Some(Errno::NoMem)
    );
    assert_eq!(resources(&group, &budget), before);
    member.physical_stopped();
}

#[test]
fn a_moved_tail_keeps_its_new_pages_reusable_and_charged() {
    let budget = GroupBackingBudget::default();
    let group = group_with(1000, budget.clone());
    let member = launch(&group, 1);
    let _before_hole = NestedMemory::new(&member, 10, 10).unwrap();
    let hole = NestedMemory::new(&member, 100, 100).unwrap();
    let _after_hole = NestedMemory::new(&member, 10, 10).unwrap();
    drop(hole);
    let inner = &group.inner;
    let plan = ReservationPlan {
        pages: 150,
        growth: 50,
        tail_hole: 100,
    };
    budget
        .charge_selected(&inner.backing, |_| Ok(plan))
        .unwrap();
    let mut state = inner.lock();
    assert_eq!(
        inner.commit_reservation_locked(&mut state, plan),
        Err(Errno::NoMem)
    );
    drop(state);
    assert_eq!(group.snapshot().free_bytes, 150 * PAGE);
    assert_eq!(group.snapshot().committed_bytes, 171 * PAGE);
    member.physical_stopped();
}
