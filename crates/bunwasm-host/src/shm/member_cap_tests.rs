//! The cumulative member cap (`GroupPolicy::member_pages`) through the real allocator and
//! backing budget: what counts, when it is charged and returned, and what a refusal leaves.
use super::*;

fn capped(maximum_pages: u32, member_pages: Option<u32>) -> Result<MemoryGroup> {
    let policy = GroupPolicy {
        maximum_pages,
        member_pages,
        ..GroupPolicy::default()
    };
    MemoryGroup::new(&Engine::default(), policy, GroupBackingBudget::default())
}

fn launch(group: &MemoryGroup, pid: u32) -> MemberLease {
    group.reserve(pid).unwrap().launch()
}

fn grow(member: &MemberLease, pages: u32) -> Result<u32, Errno> {
    member.group.grow(member.member, pages)
}

/// Everything a refused grow must leave untouched: the whole group view and the shared budget.
fn state(group: &MemoryGroup) -> (GroupSnapshot, u64) {
    let budget = group.inner.backing.budget.committed_bytes();
    (group.snapshot(), budget)
}

#[test]
fn an_omitted_cap_is_the_configured_maximum_and_an_explicit_one_is_bounded_by_it() {
    assert_eq!(capped(8, None).unwrap().inner.member_cap, 8);
    assert_eq!(capped(32768, None).unwrap().inner.member_cap, 32768);
    let service_default = MemoryGroup::new(
        &Engine::default(),
        GroupPolicy::default(),
        GroupBackingBudget::default(),
    );
    assert_eq!(service_default.unwrap().inner.member_cap, MAX_GROUP_PAGES);
    assert_eq!(capped(8, Some(8)).unwrap().inner.member_cap, 8);
    assert_eq!(capped(8, Some(1)).unwrap().inner.member_cap, 1);
    assert_eq!(capped(32768, Some(16384)).unwrap().inner.member_cap, 16384);
    // Never clamped: a cap the maximum cannot honour refuses the group.
    for refused in [0, 9, u32::MAX] {
        let error = capped(8, Some(refused)).err().expect("cap out of bounds");
        assert!(format!("{error:#}").contains("member cap"), "{error:#}");
    }
}

#[test]
fn an_omitted_cap_leaves_a_custom_maximum_group_as_it_was() {
    // Page zero is the group's own; the other seven are all a member's to take.
    let group = capped(8, None).unwrap();
    let member = launch(&group, 1);
    assert_eq!(grow(&member, 7), Ok(1));
    assert_eq!(group.snapshot().member_pages, 7);
    assert_eq!(grow(&member, 1), Err(Errno::NoMem));
}

#[test]
fn two_members_jointly_reach_the_cap_and_a_refused_grow_changes_nothing() {
    let group = capped(64, Some(10)).unwrap();
    let first = launch(&group, 1);
    let second = launch(&group, 2);
    assert_eq!(grow(&first, 6), Ok(1));
    assert_eq!(grow(&second, 4), Ok(7));
    assert_eq!(group.snapshot().member_pages, 10);
    let before = state(&group);
    // Neither member may pass the joint cap, whoever holds less, although 53 pages are free.
    for member in [&first, &second] {
        assert_eq!(grow(member, 1), Err(Errno::NoMem));
        assert_eq!(grow(member, 11), Err(Errno::NoMem));
    }
    assert_eq!(state(&group), before);
    // The failure is the cap, not the address space: the next grow lands where that one would.
    second.physical_stopped();
    assert_eq!(grow(&first, 4), Ok(7));
}

#[test]
fn regions_are_not_counted_and_stay_available_at_the_cap() {
    let group = capped(64, Some(4)).unwrap();
    let member = launch(&group, 1);
    assert_eq!(grow(&member, 4), Ok(1));
    let before = group.snapshot();
    let region = member
        .group
        .create(member.member, 3 * PAGE_BYTES, 16)
        .unwrap();
    let reserved = member
        .group
        .create_reservation(member.member, 2, 8)
        .unwrap();
    let after = group.snapshot();
    assert_eq!(after.member_pages, 4);
    assert_eq!(after.regions, 2);
    assert_eq!(
        after.committed_bytes - before.committed_bytes,
        u64::from(region.len) + u64::from(reserved.len)
    );
    assert_eq!(grow(&member, 1), Err(Errno::NoMem));
}

#[test]
fn release_returns_member_pages_while_the_backing_high_water_stays() {
    let group = capped(64, Some(10)).unwrap();
    let keeper = launch(&group, 1);
    let leaver = launch(&group, 2);
    grow(&keeper, 6).unwrap();
    let page = grow(&leaver, 3).unwrap();
    grow(&leaver, 1).unwrap();
    let committed = group.snapshot().committed_bytes;
    leaver.physical_stopped();
    let released = group.snapshot();
    assert_eq!(released.member_pages, 6);
    assert_eq!(released.committed_bytes, committed);
    assert_eq!(released.free_bytes, 4 * u64::from(PAGE_BYTES));
    // The returned pages are reused in place: no new backing, and the cap is reached again.
    assert_eq!(grow(&keeper, 4), Ok(page));
    let reused = group.snapshot();
    assert_eq!(reused.member_pages, 10);
    assert_eq!(reused.committed_bytes, committed);
    assert_eq!(grow(&keeper, 1), Err(Errno::NoMem));
}

#[test]
fn a_failed_tail_growth_is_not_charged() {
    let group = capped(64, Some(10)).unwrap();
    let member = launch(&group, 1);
    grow(&member, 2).unwrap();
    let before = state(&group);
    group
        .inner
        .fail_next_tail_growth
        .store(true, Ordering::SeqCst);
    assert_eq!(grow(&member, 8), Err(Errno::NoMem));
    assert_eq!(state(&group), before);
    // The whole remaining cap is still grantable, at the same page.
    assert_eq!(grow(&member, 8), Ok(3));
    assert_eq!(group.snapshot().member_pages, 10);
}

#[test]
fn an_aborted_reservation_and_a_partial_admission_return_exactly_what_was_granted() {
    let group = capped(64, Some(10)).unwrap();
    let root = launch(&group, 1);
    grow(&root, 5).unwrap();
    // A reserved member has been granted nothing, so its abort returns nothing.
    let reservation = group.reserve(2).unwrap();
    assert_eq!(group.snapshot().member_pages, 5);
    reservation.abort();
    assert_eq!(group.snapshot().member_pages, 5);
    // An admission that got its image but not its stack is stopped: only its pages return.
    let partial = launch(&group, 3);
    grow(&partial, 3).unwrap();
    let before = state(&group);
    assert_eq!(grow(&partial, 8), Err(Errno::NoMem));
    assert_eq!(state(&group), before);
    partial.physical_stopped();
    assert_eq!(group.snapshot().member_pages, 5);
    assert_eq!(grow(&root, 5), Ok(6));
}

#[test]
fn a_retained_member_stays_charged_until_its_own_incarnation_stops() {
    let group = capped(64, Some(10)).unwrap();
    let failed = launch(&group, 1);
    let survivor = launch(&group, 2);
    grow(&failed, 7).unwrap();
    grow(&survivor, 3).unwrap();
    failed.failed_physical_stop();
    let retained = group.snapshot();
    assert_eq!(retained.retained, 1);
    assert_eq!(retained.member_pages, 10);
    // Its pages may still be in use by a thread that never stopped: the debt keeps the cap.
    assert_eq!(grow(&survivor, 1), Err(Errno::NoMem));
    assert_eq!(group.snapshot(), retained);
    failed.physical_stopped();
    assert_eq!(group.snapshot().member_pages, 3);
    assert_eq!(grow(&survivor, 7), Ok(1));
}

#[test]
fn the_last_stop_returns_every_member_page_but_not_the_backing_charge() {
    let group = capped(64, Some(10)).unwrap();
    let lease = group.memory_lease();
    let budget = group.inner.backing.budget.clone();
    let members = [launch(&group, 1), launch(&group, 2)];
    for member in &members {
        grow(member, 5).unwrap();
    }
    let committed = budget.committed_bytes();
    for member in members {
        member.physical_stopped();
    }
    assert_eq!(group.snapshot().member_pages, 0);
    assert_eq!(budget.committed_bytes(), committed);
    drop(group);
    drop(lease);
    assert_eq!(budget.committed_bytes(), 0);
}
