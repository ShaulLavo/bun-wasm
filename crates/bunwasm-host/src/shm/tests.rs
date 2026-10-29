use super::*;
use crate::process::{self, Cancellation, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Barrier};
use std::thread::{self, JoinHandle};
use wasmtime::{Instance, Module, Store, StoreLimitsBuilder};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

fn group() -> MemoryGroup {
    MemoryGroup::new(
        &Engine::default(),
        GroupPolicy::default(),
        GroupBackingBudget::new(DEFAULT_BUDGET_BYTES),
    )
    .unwrap()
}

fn member(group: &MemoryGroup, pid: u32) -> MemberLease {
    group.reserve(pid).unwrap().launch()
}

struct WaitThread {
    cancel: WaitCancel,
    result: Receiver<WaitResult>,
    handle: Option<JoinHandle<()>>,
    gate: Option<Arc<Barrier>>,
}

impl WaitThread {
    fn spawn(registration: WaitRegistration) -> Self {
        Self::spawn_gated(registration, None)
    }

    fn spawn_gated(registration: WaitRegistration, gate: Option<Arc<Barrier>>) -> Self {
        let cancel = registration.cancel_handle();
        let (send, result) = channel();
        let thread_gate = gate.clone();
        let handle = thread::spawn(move || {
            if let Some(gate) = thread_gate {
                gate.wait();
            }
            let outcome = registration.wait();
            let _ = send.send(outcome);
        });
        Self {
            cancel,
            result,
            handle: Some(handle),
            gate,
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

    fn release_gate(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.wait();
        }
    }
}

impl Drop for WaitThread {
    fn drop(&mut self) {
        let _ = self.cancel.cancel();
        if self.handle.is_some() {
            self.release_gate();
        }
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

struct ImportThread {
    cancel: Arc<Cancellation>,
    result: Receiver<i32>,
    handle: Option<JoinHandle<()>>,
}

impl ImportThread {
    fn outcome(mut self) -> i32 {
        let result = self.result.recv_timeout(TEST_TIMEOUT).unwrap();
        self.handle.take().unwrap().join().unwrap();
        result
    }
}

impl Drop for ImportThread {
    fn drop(&mut self) {
        self.cancel.kill(9);
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

fn wait_for_waiters(group: &MemoryGroup, count: usize) {
    let deadline = Instant::now() + TEST_TIMEOUT;
    while group.snapshot().waiters < count {
        assert!(Instant::now() < deadline, "waiter registration timed out");
        thread::yield_now();
    }
}

fn registered(preparation: WaitPreparation) -> WaitRegistration {
    match preparation {
        WaitPreparation::Registered(registration) => registration,
        WaitPreparation::NotEqual | WaitPreparation::TimedOut => panic!("waiter must register"),
    }
}

fn wait_guest() -> Vec<u8> {
    fn section(module: &mut Vec<u8>, id: u8, payload: &[u8]) {
        assert!(payload.len() < 128);
        module.extend_from_slice(&[id, payload.len() as u8]);
        module.extend_from_slice(payload);
    }

    let mut module = b"\0asm\x01\0\0\0".to_vec();
    section(&mut module, 1, &[1, 0x60, 3, 0x7f, 0x7f, 0x7e, 1, 0x7f]);
    let mut import = vec![1, 11];
    import.extend_from_slice(b"runtime_shm");
    import.push(12);
    import.extend_from_slice(b"futex_wait32");
    import.extend_from_slice(&[0, 0]);
    section(&mut module, 2, &import);
    section(&mut module, 3, &[1, 0]);
    section(&mut module, 7, &[1, 4, b'w', b'a', b'i', b't', 0, 1]);
    let body = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x10, 0, 0x0b];
    let mut code = vec![1, body.len() as u8];
    code.extend_from_slice(&body);
    section(&mut module, 10, &code);
    module
}

#[test]
fn defaults_preserve_member_and_page_budget_policy() {
    let policy = GroupPolicy::default();
    assert_eq!(policy.members, 16);
    assert_eq!(policy.parallelism, 1);
    let budget = GroupBackingBudget::new(DEFAULT_BUDGET_BYTES);
    assert_eq!(budget.limit_bytes, 2 * 1024 * 1024 * 1024);
    assert_eq!(policy.maximum_pages, 65536);
}

#[test]
fn shared_budget_limits_multiple_groups_and_releases_with_the_owner() {
    let budget = GroupBackingBudget::new(2 * u64::from(PAGE_BYTES));
    let first =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    let second =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    assert_eq!(budget.committed_bytes(), 2 * u64::from(PAGE_BYTES));
    let owner = member(&first, 1);
    assert_eq!(owner.group.grow(owner.member, 1), Err(Errno::NoMem));
    assert!(MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).is_err());
    drop(second);
    assert_eq!(budget.committed_bytes(), u64::from(PAGE_BYTES));
    let third =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    assert_eq!(budget.committed_bytes(), 2 * u64::from(PAGE_BYTES));
    assert_eq!(third.snapshot().committed_bytes, u64::from(PAGE_BYTES));
}

#[test]
fn bypass_growth_is_reconciled_and_blocks_further_admission() {
    let budget = GroupBackingBudget::new(u64::from(PAGE_BYTES));
    let group =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    let owner = member(&group, 1);
    let lease = group.memory_lease();
    // SAFETY: `lease` remains alive until after the group and raw backing checks.
    unsafe { lease.memory_for_admission() }.grow(1).unwrap();
    let snapshot = group.snapshot();
    assert!(snapshot.bypassed);
    assert_eq!(snapshot.committed_bytes, 2 * u64::from(PAGE_BYTES));
    assert_eq!(budget.committed_bytes(), 2 * u64::from(PAGE_BYTES));
    assert_eq!(group_grow(&owner, 1), Errno::NoMem.result());
    assert!(matches!(group.reserve(2), Err(Errno::Inval)));
    owner.physical_stopped();
    drop(group);
    assert_eq!(budget.committed_bytes(), 2 * u64::from(PAGE_BYTES));
    drop(lease);
    assert_eq!(budget.committed_bytes(), 0);
}

#[test]
fn escaped_memory_lease_retains_charge_until_raw_users_and_lease_drop() {
    let budget = GroupBackingBudget::new(u64::from(PAGE_BYTES));
    let group =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    let lease = group.memory_lease();
    // SAFETY: `lease` is retained until `escaped` has dropped.
    let escaped = unsafe { lease.memory_for_admission() }.clone();
    drop(group);
    assert_eq!(budget.committed_bytes(), u64::from(PAGE_BYTES));
    assert!(MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).is_err());
    drop(escaped);
    assert_eq!(budget.committed_bytes(), u64::from(PAGE_BYTES));
    let last_lease = lease.clone();
    drop(lease);
    assert_eq!(budget.committed_bytes(), u64::from(PAGE_BYTES));
    drop(last_lease);
    assert_eq!(budget.committed_bytes(), 0);
}

#[test]
fn a_new_group_reconciles_growth_in_every_owned_group() {
    let budget = GroupBackingBudget::new(2 * u64::from(PAGE_BYTES));
    let first =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    let lease = first.memory_lease();
    // SAFETY: `lease` outlives this raw growth and the following admission.
    unsafe { lease.memory_for_admission() }.grow(1).unwrap();
    assert!(MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).is_err());
    assert_eq!(budget.committed_bytes(), 2 * u64::from(PAGE_BYTES));
    drop(lease);
    drop(first);
    assert_eq!(budget.committed_bytes(), 0);
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
        GroupBackingBudget::new(DEFAULT_BUDGET_BYTES),
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
        GroupBackingBudget::new(DEFAULT_BUDGET_BYTES),
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
fn allocation_boundaries_reject_overflow_alignment_and_budget_exhaustion() {
    let group = MemoryGroup::new(
        &Engine::default(),
        GroupPolicy::default(),
        GroupBackingBudget::new(2 * u64::from(PAGE_BYTES)),
    )
    .unwrap();
    let owner = member(&group, 1);
    assert_eq!(owner.group.grow(owner.member, 0), Err(Errno::Inval));
    assert_eq!(
        owner.group.grow(owner.member, MAX_GROUP_PAGES + 1),
        Err(Errno::Inval)
    );
    assert_eq!(owner.group.create(owner.member, 0, 16), Err(Errno::Inval));
    assert_eq!(
        owner.group.create(owner.member, 0x8000_0000, 16),
        Err(Errno::Inval)
    );
    assert_eq!(owner.group.create(owner.member, 64, 3), Err(Errno::Inval));
    assert_eq!(
        owner.group.create(owner.member, 64, PAGE_BYTES * 2),
        Err(Errno::Inval)
    );
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let before = group.snapshot();
    assert_eq!(owner.group.create(owner.member, 64, 16), Err(Errno::NoMem));
    assert_eq!(group.snapshot(), before);
    owner.group.detach(owner.member, region.handle).unwrap();
    assert_eq!(
        owner.group.create(owner.member, 64, 16).unwrap().addr,
        region.addr
    );
}

#[test]
fn invalid_output_spans_leave_regions_holds_pins_and_watches_unchanged() {
    let group = group();
    let owner = member(&group, 1);
    let receiver = member(&group, 2);
    let out_of_bounds = u32::MAX - 3;
    let before = group.snapshot();
    assert_eq!(shm_create(&owner, 64, 16, 1), Errno::Inval.result());
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
fn zero_timeout_settles_after_comparison_without_registration() {
    let group = group();
    let owner = member(&group, 1);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let waiting = owner.prepare_wait32(region.addr, 0, 0).unwrap();
    assert!(matches!(waiting, WaitPreparation::TimedOut));
    assert_eq!(waiting.wait(), WaitResult::TimedOut);
    assert_eq!(group.snapshot().waiters, 0);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 0);
    assert_eq!(
        owner.prepare_wait32(region.addr, 1, 0).unwrap().wait(),
        WaitResult::NotEqual
    );
}

#[test]
fn wake_skips_an_expired_registration_without_consuming_count() {
    let group = group();
    let owner = member(&group, 1);
    let expired_member = member(&group, 2);
    let live_member = member(&group, 3);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let expired = registered(expired_member.prepare_wait32(region.addr, 0, 1).unwrap());
    while !expired.waiter.expired(Instant::now()) {
        thread::yield_now();
    }
    let live = registered(live_member.prepare_wait32(region.addr, 0, -1).unwrap());
    let expired = WaitThread::spawn(expired);
    let live = WaitThread::spawn(live);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(expired.outcome(), WaitResult::TimedOut);
    assert_eq!(live.outcome(), WaitResult::Ok);
    assert_eq!(group.snapshot().waiters, 0);
}

#[test]
fn dropping_a_registration_restores_the_next_wake_for_a_live_waiter() {
    let group = group();
    let owner = member(&group, 1);
    let abandoned_member = member(&group, 2);
    let live_member = member(&group, 3);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let abandoned = registered(abandoned_member.prepare_wait32(region.addr, 0, -1).unwrap());
    drop(abandoned);
    assert_eq!(group.snapshot().waiters, 0);
    let live = registered(live_member.prepare_wait32(region.addr, 0, -1).unwrap());
    let live = WaitThread::spawn(live);
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    assert_eq!(live.outcome(), WaitResult::Ok);
}

#[test]
fn delayed_waiter_intent_survives_a_250ms_scheduling_delay() {
    let group = group();
    let owner = member(&group, 1);
    let waiter = member(&group, 2);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let registration = registered(waiter.prepare_wait32(region.addr, 0, -1).unwrap());
    let barrier = Arc::new(Barrier::new(2));
    let mut waiting = WaitThread::spawn_gated(registration, Some(barrier));
    assert_eq!(owner.wake(region.addr, 1).unwrap(), 1);
    thread::sleep(Duration::from_millis(250));
    waiting.release_gate();
    assert_eq!(waiting.outcome(), WaitResult::Ok);
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
    owner.group.attach(owner.member, region.handle).unwrap();
    assert_eq!(group.snapshot().holds, 2);
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
fn admitted_import_cancellation_interrupts_only_its_member_before_stop_release() {
    let engine = Engine::default();
    let module = Module::new(&engine, wait_guest()).unwrap();
    let group = group();
    let owner = member(&group, 1);
    let guest = member(&group, 2);
    let survivor_member = member(&group, 3);
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let cancel = Arc::new(Cancellation::default());
    let runtime = process::Runtime::new(engine.clone(), module.clone(), Vec::new()).unwrap();
    let net = crate::net::Net::new();
    let stdio = Stdio::inherited();
    let mut wasi = wasmtime_wasi::WasiCtxBuilder::new();
    stdio.install(&mut wasi, cancel.clone());
    let processes = process::Processes::new(runtime.clone(), stdio, net.notify(), cancel.clone());
    let host = Host {
        wasi: wasi.build_p1(),
        net,
        memory: None,
        trace: false,
        processes,
        shm: Some(guest),
        limits: StoreLimitsBuilder::new().build(),
        functions: Vec::new(),
        cancel: cancel.clone(),
        cwd: "/".into(),
    };
    let mut linker = Linker::new(&engine);
    add_imports(&mut linker).unwrap();
    let mut store = Store::new(&engine, host);
    let instance: Instance = linker.instantiate(&mut store, &module).unwrap();
    let wait = instance
        .get_typed_func::<(u32, i32, i64), i32>(&mut store, "wait")
        .unwrap();
    let (send, result) = channel();
    let addr = region.addr;
    let handle = thread::spawn(move || {
        let outcome = wait.call(&mut store, (addr, 0, -1)).unwrap();
        let lease = store.data_mut().shm.take().unwrap();
        drop(store);
        runtime.shutdown();
        lease.physical_stopped();
        let _ = send.send(outcome);
    });
    let guest = ImportThread {
        cancel,
        result,
        handle: Some(handle),
    };
    wait_for_waiters(&group, 1);
    let survivor = registered(survivor_member.prepare_wait32(addr, 0, -1).unwrap());
    let survivor = WaitThread::spawn(survivor);
    wait_for_waiters(&group, 2);
    guest.cancel.kill(9);
    assert_eq!(guest.outcome(), Errno::Interrupted.result());
    assert_eq!(group.snapshot().waiters, 1);
    assert_eq!(owner.wake(addr, 1).unwrap(), 1);
    assert_eq!(survivor.outcome(), WaitResult::Ok);
    assert_eq!(group.snapshot().retained, 0);
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
