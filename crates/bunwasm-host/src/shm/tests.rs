use super::*;
use std::sync::mpsc::{Receiver, channel};
use std::thread::{self, JoinHandle};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

fn group() -> MemoryGroup {
    MemoryGroup::new(&Engine::default(), GroupPolicy::default()).unwrap()
}

fn member(group: &MemoryGroup, pid: u32) -> MemberLease {
    group.reserve(pid).unwrap().launch()
}

struct WaitThread {
    cancel: WaitCancel,
    result: Receiver<WaitResult>,
    handle: Option<JoinHandle<()>>,
}

impl WaitThread {
    fn spawn(registration: WaitRegistration) -> Self {
        let cancel = registration.cancel_handle();
        let (send, result) = channel();
        let handle = thread::spawn(move || {
            let outcome = registration.wait();
            let _ = send.send(outcome);
        });
        Self {
            cancel,
            result,
            handle: Some(handle),
        }
    }

    fn outcome(mut self) -> WaitResult {
        let outcome = self
            .result
            .recv_timeout(TEST_TIMEOUT)
            .expect("waiter completed");
        self.handle.take().unwrap().join().unwrap();
        outcome
    }
}

impl Drop for WaitThread {
    fn drop(&mut self) {
        let _ = self.cancel.cancel();
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

fn registered(preparation: WaitPreparation) -> WaitRegistration {
    match preparation {
        WaitPreparation::Registered(registration) => registration,
        WaitPreparation::NotEqual => panic!("waiter must register"),
    }
}

#[test]
fn defaults_preserve_member_and_page_budget_policy() {
    let policy = GroupPolicy::default();
    assert_eq!(policy.members, 16);
    assert_eq!(policy.parallelism, 1);
    assert_eq!(policy.budget_bytes, 2 * 1024 * 1024 * 1024);
    assert_eq!(policy.maximum_pages, 65536);
    assert_eq!(POLL_FUTEX_KIND, 7);
}

#[test]
fn regions_alias_and_recycle_only_after_holds_and_pins_settle() {
    let group = group();
    let owner = member(&group, 1);
    let receiver = member(&group, 2);
    let created = owner.group.create(owner.member, 32, 16).unwrap();
    let attached = owner.group.attach(owner.member, created.handle).unwrap();
    assert_eq!(attached, created);
    group.store32(created.addr, 0x1234_5678).unwrap();
    let pin = owner.group.pin(owner.member, created.handle).unwrap();
    owner.group.route(owner.member, pin, 2).unwrap();
    owner.group.detach(owner.member, created.handle).unwrap();
    owner.group.detach(owner.member, created.handle).unwrap();
    assert_eq!(group.snapshot().regions, 1);
    assert_eq!(group.snapshot().pins, 1);
    let accepted = receiver.group.accept(receiver.member, pin).unwrap();
    assert_eq!(accepted, created);
    assert_eq!(group.load32(accepted.addr).unwrap(), 0x1234_5678);
    assert_eq!(group.snapshot().holds, 1);
    assert_eq!(group.snapshot().pins, 0);
    receiver
        .group
        .detach(receiver.member, created.handle)
        .unwrap();
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().free_bytes, u64::from(PAGE_BYTES));
    let reused = owner.group.create(owner.member, 32, 16).unwrap();
    assert_eq!(reused.addr, created.addr);
    assert_eq!(group.load32(reused.addr).unwrap(), 0);
}

#[test]
fn concurrent_pins_route_to_one_receiver() {
    let group = MemoryGroup::new(
        &Engine::default(),
        GroupPolicy {
            members: 7,
            ..GroupPolicy::default()
        },
    )
    .unwrap();
    let owner = member(&group, 1);
    let receiver = member(&group, 2);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let mut workers = Vec::new();
    for pid in 3..=6 {
        let worker = member(&group, pid);
        worker.group.attach(worker.member, region.handle).unwrap();
        workers.push(thread::spawn(move || {
            let pin = worker.group.pin(worker.member, region.handle).unwrap();
            worker.group.route(worker.member, pin, 2).unwrap();
            worker.physical_stopped();
            pin
        }));
    }
    for worker in workers {
        let pin = worker.join().unwrap();
        assert_eq!(receiver.group.accept(receiver.member, pin).unwrap(), region);
    }
    assert_eq!(group.snapshot().pins, 0);
    assert_eq!(group.snapshot().holds, 5);
}

#[test]
fn failed_launch_abort_returns_member_capacity() {
    let group = MemoryGroup::new(
        &Engine::default(),
        GroupPolicy {
            members: 2,
            ..GroupPolicy::default()
        },
    )
    .unwrap();
    let _owner = member(&group, 1);
    let reservation = group.reserve(2).unwrap();
    let index = reservation.id().index;
    assert!(matches!(group.reserve(3), Err(Errno::Again)));
    reservation.abort();
    let replacement = group.reserve(3).unwrap();
    assert_eq!(replacement.id().index, index);
}

#[test]
fn invalid_output_spans_leave_regions_holds_pins_and_watches_unchanged() {
    let group = group();
    let owner = member(&group, 1);
    let receiver = member(&group, 2);
    let out_of_bounds = u32::MAX - 3;
    let before = group.snapshot();
    assert_eq!(
        shm_create(&owner, 64, 16, out_of_bounds),
        Errno::Inval.result()
    );
    assert_eq!(group.snapshot(), before);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let before = group.snapshot();
    assert_eq!(
        shm_attach(&owner, region.handle.0, out_of_bounds),
        Errno::Inval.result()
    );
    assert_eq!(
        shm_pin(&owner, region.handle.0, out_of_bounds),
        Errno::Inval.result()
    );
    assert_eq!(
        futex_watch(&owner, region.addr, 0, out_of_bounds),
        Errno::Inval.result()
    );
    assert_eq!(group.snapshot(), before);
    let pin = owner.group.pin(owner.member, region.handle).unwrap();
    owner.group.route(owner.member, pin, 2).unwrap();
    let before = group.snapshot();
    assert_eq!(
        shm_accept(&receiver, pin.0, out_of_bounds),
        Errno::Inval.result()
    );
    assert_eq!(group.snapshot(), before);
    assert_eq!(receiver.group.accept(receiver.member, pin).unwrap(), region);
}

#[test]
fn delayed_waiter_intent_survives_a_250ms_scheduling_delay() {
    let group = group();
    let owner = member(&group, 1);
    let waiter = member(&group, 2);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let registration = registered(waiter.prepare_wait32(region.addr, 0, -1).unwrap());
    let cancel = registration.cancel_handle();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let waiter_barrier = barrier.clone();
    let (send, result) = channel();
    let handle = thread::spawn(move || {
        waiter_barrier.wait();
        let outcome = registration.wait();
        let _ = send.send(outcome);
    });
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    thread::sleep(Duration::from_millis(250));
    barrier.wait();
    assert_eq!(result.recv_timeout(TEST_TIMEOUT), Ok(WaitResult::Ok));
    handle.join().unwrap();
    let _ = cancel;
}

#[test]
fn partial_wakes_are_sync_first_and_hit_each_watch_once() {
    let group = group();
    let owner = member(&group, 1);
    let first_member = member(&group, 2);
    let second_member = member(&group, 3);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let first_watch = owner.watch(region.addr, 0).unwrap();
    let second_watch = owner.watch(region.addr, 0).unwrap();
    let first = registered(first_member.prepare_wait32(region.addr, 0, -1).unwrap());
    let second = registered(second_member.prepare_wait32(region.addr, 0, -1).unwrap());
    let first = WaitThread::spawn(first);
    let second = WaitThread::spawn(second);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(first.outcome(), WaitResult::Ok);
    assert!(!owner.watch_ready(first_watch).unwrap());
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(second.outcome(), WaitResult::Ok);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert!(owner.watch_ready(first_watch).unwrap());
    assert!(!owner.watch_ready(second_watch).unwrap());
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert!(owner.watch_ready(second_watch).unwrap());
    owner.unwatch(first_watch).unwrap();
    let replacement = owner.watch(region.addr, 0).unwrap();
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert!(owner.watch_ready(replacement).unwrap());
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 0);
}

#[test]
fn cancelling_one_of_many_removes_only_that_waiter() {
    let group = group();
    let owner = member(&group, 1);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let first = registered(
        member(&group, 2)
            .prepare_wait32(region.addr, 0, -1)
            .unwrap(),
    );
    let cancelled = registered(
        member(&group, 3)
            .prepare_wait32(region.addr, 0, -1)
            .unwrap(),
    );
    let survivor = registered(
        member(&group, 4)
            .prepare_wait32(region.addr, 0, -1)
            .unwrap(),
    );
    let first = WaitThread::spawn(first);
    let cancel = cancelled.cancel_handle();
    let cancelled = WaitThread::spawn(cancelled);
    let survivor = WaitThread::spawn(survivor);
    cancel.cancel().unwrap();
    assert_eq!(cancelled.outcome(), WaitResult::Interrupted);
    assert_eq!(Errno::Interrupted.result(), -27);
    assert_eq!(group.snapshot().waiters, 2);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(first.outcome(), WaitResult::Ok);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(survivor.outcome(), WaitResult::Ok);
}

#[test]
fn wait_timeout_mismatch_alignment_and_ranges_follow_the_abi() {
    let group = group();
    let owner = member(&group, 1);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    assert_eq!(
        owner.wait32(region.addr, 1, -1).unwrap(),
        WaitResult::NotEqual
    );
    assert_eq!(
        owner.wait32(region.addr, 0, 1_000_000).unwrap(),
        WaitResult::TimedOut
    );
    assert_eq!(owner.wait32(region.addr + 1, 0, -1), Err(Errno::Inval));
    assert_eq!(owner.wait64(region.addr + 4, 0, -1), Err(Errno::Inval));
    assert_eq!(owner.wait32(u32::MAX - 3, 0, -1), Err(Errno::Inval));
    assert_eq!(owner.wake(region.addr + 1, 1), Err(Errno::Inval));
    group.store64(region.addr + 8, 9).unwrap();
    assert_eq!(
        owner.wait64(region.addr + 8, 8, -1).unwrap(),
        WaitResult::NotEqual
    );
    let waiting = registered(owner.prepare_wait64(region.addr + 8, 9, -1).unwrap());
    let waiting = WaitThread::spawn(waiting);
    assert_eq!(owner.wake(region.addr + 8, 1).unwrap(), 1);
    assert_eq!(waiting.outcome(), WaitResult::Ok);
}

#[test]
fn watch_readiness_tracks_value_changes_without_consuming_a_wake() {
    let group = group();
    let owner = member(&group, 1);
    let other = member(&group, 2);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let watch = owner.watch(region.addr, 0).unwrap();
    assert!(!owner.watch_ready(watch).unwrap());
    group.store32(region.addr, 1).unwrap();
    assert!(owner.watch_ready(watch).unwrap());
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(other.unwatch(watch), Err(Errno::BadF));
    owner.unwatch(watch).unwrap();
    assert_eq!(owner.watch_ready(watch), Err(Errno::BadF));
}

#[test]
fn failed_stop_retains_debt_until_the_same_incarnation_stops() {
    let group = group();
    let owner = member(&group, 1);
    let receiver = member(&group, 2);
    let survivor = member(&group, 3);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let grown = owner.group.grow(owner.member, 1).unwrap();
    let pin = owner.group.pin(owner.member, region.handle).unwrap();
    owner.group.route(owner.member, pin, 2).unwrap();
    owner.failed_physical_stop();
    assert_eq!(group.snapshot().retained, 1);
    assert_eq!(group.snapshot().regions, 1);
    assert_eq!(group.snapshot().free_bytes, 0);
    receiver.physical_stopped();
    assert_eq!(group.snapshot().pins, 0);
    assert_eq!(group.snapshot().regions, 1);
    assert_eq!(group.snapshot().retained, 1);
    owner.physical_stopped();
    assert_eq!(group.snapshot().retained, 0);
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().free_bytes, 2 * u64::from(PAGE_BYTES));
    let reused = survivor.group.create(survivor.member, 64, 16).unwrap();
    assert_eq!(reused.addr, region.addr);
    let next = survivor.group.grow(survivor.member, 1).unwrap();
    assert_eq!(next, grown);
}

#[test]
fn wait_thread_guard_cancels_and_joins_during_unwind() {
    let group = group();
    let owner = member(&group, 1);
    let waiter = member(&group, 2);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let registration = registered(waiter.prepare_wait32(region.addr, 0, -1).unwrap());
        let _waiting = WaitThread::spawn(registration);
        panic!("exercise waiter cleanup");
    }));
    assert!(result.is_err());
    assert_eq!(group.snapshot().waiters, 0);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 0);
}

#[test]
fn stale_cancellation_cannot_target_a_reused_member_slot() {
    let group = group();
    let owner = member(&group, 1);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let first_member = member(&group, 2);
    let first = registered(first_member.prepare_wait32(region.addr, 0, -1).unwrap());
    let first_index = first_member.id().index;
    let stale = first.cancel_handle();
    first_member.failed_physical_stop();
    first_member.physical_stopped();
    assert_eq!(first.wait(), WaitResult::Interrupted);
    let second_member = member(&group, 3);
    assert_eq!(second_member.id().index, first_index);
    let second = registered(second_member.prepare_wait32(region.addr, 0, -1).unwrap());
    assert_eq!(stale.cancel(), Err(Errno::BadF));
    let second = WaitThread::spawn(second);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(second.outcome(), WaitResult::Ok);
}
