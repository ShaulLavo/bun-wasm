use super::*;

fn pinned(owner: &MemberLease) -> (SharedBacking, PinId) {
    let region = owner.group.create(owner.member, 64, 16).unwrap();
    let pin = owner.group.pin(owner.member, region.handle).unwrap();
    (region, pin)
}

#[test]
fn conversion_requires_the_owner_and_changes_only_ownership() {
    let group = group();
    let owner = member(&group, 1);
    let peer = member(&group, 2);
    let (_, pin) = pinned(&owner);
    let before = group.snapshot();
    let next_pin = group.inner.lock().next_pin;
    assert_eq!(shm_route_group(&owner, 0), Errno::BadF.result());
    assert_eq!(shm_route_group(&peer, pin.0), Errno::BadF.result());
    assert_eq!(shm_unpin(&peer, pin.0), Errno::BadF.result());
    assert_eq!(group.snapshot(), before);
    assert_eq!(shm_route_group(&owner, pin.0), 0);
    assert_eq!(group.snapshot(), before);
    assert_eq!(group.inner.lock().next_pin, next_pin);
    assert_eq!(group.inner.lock().pins[&pin].owner, PinOwner::Group);
    assert_eq!(shm_route_group(&owner, pin.0), Errno::BadF.result());
    assert_eq!(shm_route_group(&peer, pin.0), Errno::BadF.result());
    assert_eq!(group.snapshot(), before);
    assert_eq!(shm_unpin(&peer, pin.0), 0);
    assert_eq!(shm_unpin(&owner, pin.0), Errno::BadF.result());
}

#[test]
fn ordinary_route_and_accept_refuse_group_pins_before_mutation() {
    let group = group();
    let owner = member(&group, 1);
    let peer = member(&group, 2);
    let (_, pin) = pinned(&owner);
    assert_eq!(shm_route_group(&owner, pin.0), 0);
    let before = group.snapshot();
    group.store32(0, 123).unwrap();
    assert_eq!(shm_route(&owner, pin.0, 2), Errno::BadF.result());
    assert_eq!(shm_route(&peer, pin.0, 999), Errno::BadF.result());
    assert_eq!(shm_accept(&owner, pin.0, 0), Errno::BadF.result());
    assert_eq!(shm_accept(&peer, pin.0, 0), Errno::BadF.result());
    assert_eq!(group.load32(0).unwrap(), 123);
    assert_eq!(group.snapshot(), before);
    assert_eq!(group.inner.lock().pins[&pin].owner, PinOwner::Group);
}

#[test]
fn group_authority_is_scoped_to_the_callers_group() {
    let first = group();
    let second = group();
    let owner = member(&first, 1);
    let foreign = member(&second, 1);
    assert_eq!(owner.id(), foreign.id());
    let (_, pin) = pinned(&owner);
    assert_eq!(shm_route_group(&owner, pin.0), 0);
    let before = first.snapshot();
    assert_eq!(shm_route_group(&foreign, pin.0), Errno::BadF.result());
    assert_eq!(shm_unpin(&foreign, pin.0), Errno::BadF.result());
    assert_eq!(first.snapshot(), before);
    // The same numeric ID in another group names only that group's pin.
    let (_, foreign_pin) = pinned(&foreign);
    assert_eq!(foreign_pin, pin);
    assert_eq!(shm_route_group(&foreign, foreign_pin.0), 0);
    assert_eq!(shm_unpin(&foreign, pin.0), 0);
    assert_eq!(first.snapshot(), before);
    assert_eq!(shm_unpin(&owner, pin.0), 0);
}

#[test]
fn conversion_does_not_bypass_the_pin_quota() {
    let group = MemoryGroup::new(
        &Engine::default(),
        GroupPolicy {
            pins: 1,
            ..GroupPolicy::default()
        },
        GroupBackingBudget::default(),
    )
    .unwrap();
    let owner = member(&group, 1);
    let (region, pin) = pinned(&owner);
    let before = group.snapshot();
    assert_eq!(shm_route_group(&owner, pin.0), 0);
    assert_eq!(
        owner.group.pin(owner.member, region.handle),
        Err(Errno::Again)
    );
    assert_eq!(group.snapshot(), before);
    assert_eq!(shm_unpin(&owner, pin.0), 0);
    assert!(owner.group.pin(owner.member, region.handle).is_ok());
}

#[test]
fn root_and_member_pins_survive_their_creators_with_a_live_survivor() {
    let group = group();
    let root = member(&group, 1);
    let child = member(&group, 2);
    let survivor = member(&group, 3);
    let (ledger, root_pin) = pinned(&root);
    let (lane, child_pin) = pinned(&child);
    assert_eq!(shm_route_group(&root, root_pin.0), 0);
    assert_eq!(shm_route_group(&child, child_pin.0), 0);
    root.physical_stopped();
    child.physical_stopped();
    assert_eq!(group.snapshot().regions, 2);
    assert_eq!(group.snapshot().pins, 2);
    assert_eq!(group.snapshot().holds, 0);
    group.store32(ledger.addr, 17).unwrap();
    group.store32(lane.addr, 29).unwrap();
    let other = survivor.group.create(survivor.member, 64, 16).unwrap();
    assert_ne!(other.addr, ledger.addr);
    assert_ne!(other.addr, lane.addr);
    assert_eq!(group.load32(ledger.addr).unwrap(), 17);
    assert_eq!(group.load32(lane.addr).unwrap(), 29);
    // A hold still protects the region after a different member unpins it.
    survivor
        .group
        .attach(survivor.member, ledger.handle)
        .unwrap();
    assert_eq!(shm_unpin(&survivor, root_pin.0), 0);
    assert_eq!(shm_unpin(&survivor, child_pin.0), 0);
    assert_eq!(group.snapshot().regions, 2);
    survivor
        .group
        .detach(survivor.member, ledger.handle)
        .unwrap();
    assert_eq!(group.snapshot().regions, 1);
    survivor.physical_stopped();
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().pins, 0);
}

#[test]
fn final_reserved_member_abort_drops_group_pins_and_preserves_backing_leases() {
    let budget = GroupBackingBudget::default();
    let group =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    let backing_lease = group.memory_lease();
    let root = member(&group, 1);
    let pending = group.reserve(2).unwrap();
    let (_, pin) = pinned(&root);
    assert_eq!(shm_route_group(&root, pin.0), 0);
    root.physical_stopped();
    assert_eq!(group.snapshot().reserved, 1);
    assert_eq!(group.snapshot().regions, 1);
    assert_eq!(group.snapshot().pins, 1);
    pending.abort();
    assert!(group.inner.lock().ended);
    assert_eq!(group.snapshot().members, 0);
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().pins, 0);
    let charge = group.snapshot().committed_bytes;
    assert!(charge > 0);
    assert_eq!(budget.committed_bytes(), charge);
    drop(group);
    assert_eq!(budget.committed_bytes(), charge);
    drop(backing_lease);
    assert_eq!(budget.committed_bytes(), 0);
}

#[test]
fn non_launched_and_stale_incarnations_cannot_change_group_pins() {
    let group = group();
    let root = member(&group, 1);
    let pending = group.reserve(2).unwrap();
    let pending_id = pending.id();
    let (_, pin) = pinned(&root);
    assert_eq!(shm_route(&root, pin.0, 2), 0);
    let before = group.snapshot();
    assert_eq!(group.inner.route_group(pending_id, pin), Err(Errno::Search));
    assert_eq!(group.inner.unpin(pending_id, pin), Err(Errno::Search));
    assert_eq!(group.snapshot(), before);
    let child = pending.launch();
    assert_eq!(shm_route_group(&child, pin.0), 0);
    let (_, member_pin) = pinned(&child);
    child.failed_physical_stop();
    let before = group.snapshot();
    assert_eq!(
        shm_route_group(&child, member_pin.0),
        Errno::Search.result()
    );
    assert_eq!(shm_route_group(&child, pin.0), Errno::Search.result());
    assert_eq!(shm_unpin(&child, pin.0), Errno::Search.result());
    assert_eq!(group.snapshot(), before);
    child.physical_stopped();
    let before = group.snapshot();
    assert_eq!(group.inner.route_group(pending_id, pin), Err(Errno::Search));
    assert_eq!(group.inner.unpin(pending_id, pin), Err(Errno::Search));
    assert_eq!(group.snapshot(), before);
    let replacement = member(&group, 2);
    assert_eq!(replacement.id().index, pending_id.index);
    assert_ne!(replacement.id(), pending_id);
    let before = group.snapshot();
    group.inner.release(pending_id);
    assert_eq!(group.inner.unpin(pending_id, pin), Err(Errno::Search));
    assert_eq!(group.snapshot(), before);
    assert_eq!(shm_unpin(&replacement, member_pin.0), Errno::BadF.result());
    assert_eq!(shm_unpin(&replacement, pin.0), 0);
}

#[test]
fn retained_last_member_keeps_group_pins_until_physical_stop() {
    let group = group();
    let root = member(&group, 1);
    let child = member(&group, 2);
    let root_id = root.id();
    let (_, pin) = pinned(&root);
    assert_eq!(shm_route_group(&root, pin.0), 0);
    child.failed_physical_stop();
    root.physical_stopped();
    assert_eq!(group.snapshot().retained, 1);
    assert_eq!(group.snapshot().pins, 1);
    assert!(!group.inner.lock().ended);
    child.physical_stopped();
    let before = group.snapshot();
    assert_eq!(before.regions, 0);
    assert_eq!(before.pins, 0);
    assert!(group.inner.lock().ended);
    group.inner.release(root_id);
    assert_eq!(group.snapshot(), before);
}

#[test]
fn competing_unpins_decrement_once_and_release_is_idempotent() {
    let group = group();
    let root = member(&group, 1);
    let first = member(&group, 2);
    let second = member(&group, 3);
    let (_, pin) = pinned(&root);
    assert_eq!(shm_route_group(&root, pin.0), 0);
    let root_id = root.id();
    root.physical_stopped();
    let barrier = Barrier::new(2);
    let mut outcomes = thread::scope(|scope| {
        let first = scope.spawn(|| {
            barrier.wait();
            shm_unpin(&first, pin.0)
        });
        let second = scope.spawn(|| {
            barrier.wait();
            shm_unpin(&second, pin.0)
        });
        [first.join().unwrap(), second.join().unwrap()]
    });
    outcomes.sort();
    assert_eq!(outcomes, [Errno::BadF.result(), 0]);
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().pins, 0);
    let before = group.snapshot();
    group.inner.release(root_id);
    assert_eq!(group.snapshot(), before);
    first.physical_stopped();
    second.physical_stopped();
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().pins, 0);
}

#[test]
fn conversion_and_member_release_are_one_locked_owner_transition() {
    let group = group();
    let root = member(&group, 1);
    let survivor = member(&group, 2);
    let (_, pin) = pinned(&root);
    let id = root.id();
    let barrier = Barrier::new(2);
    let outcome = thread::scope(|scope| {
        let route = scope.spawn(|| {
            barrier.wait();
            group.inner.route_group(id, pin)
        });
        barrier.wait();
        root.physical_stopped();
        route.join().unwrap()
    });
    match outcome {
        Ok(()) => {
            assert_eq!(group.snapshot().pins, 1);
            assert_eq!(shm_unpin(&survivor, pin.0), 0);
        }
        Err(Errno::Search) => {
            assert_eq!(group.snapshot().pins, 0);
            assert_eq!(shm_unpin(&survivor, pin.0), Errno::BadF.result());
        }
        other => panic!("unexpected conversion outcome: {other:?}"),
    }
    assert_eq!(group.snapshot().regions, 0);
}

#[test]
fn final_stop_retires_group_pins_and_publications_on_the_same_region() {
    let group = group();
    let root = member(&group, 1);
    let child = member(&group, 2);
    let memory = nested::NestedMemory::new(&root, 1, 1).unwrap();
    memory.publish().unwrap();
    let handle = group
        .inner
        .lock()
        .regions
        .values()
        .find(|region| region.backing.addr == memory.base())
        .unwrap()
        .backing
        .handle;
    let pin = root.group.pin(root.member, handle).unwrap();
    assert_eq!(shm_route_group(&root, pin.0), 0);
    drop(memory);
    root.physical_stopped();
    assert_eq!(group.snapshot().published, 1);
    assert_eq!(group.snapshot().pins, 1);
    assert_eq!(group.snapshot().holds, 0);
    child.physical_stopped();
    assert_eq!(group.snapshot().published, 0);
    assert_eq!(group.snapshot().pins, 0);
    assert_eq!(group.snapshot().regions, 0);
}

#[test]
fn route_group_import_has_the_exact_signature_and_unsupported_boundary() {
    use wasm_encoder::{
        EntityType, ExportKind, ExportSection, ImportSection, TypeSection, ValType,
    };
    let engine = Engine::default();
    let mut binary = wasm_encoder::Module::new();
    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I32]);
    binary.section(&types);
    let mut imports = ImportSection::new();
    imports.import("runtime_shm", "shm_route_group", EntityType::Function(0));
    binary.section(&imports);
    let mut exports = ExportSection::new();
    exports.export("route_group", ExportKind::Func, 0);
    binary.section(&exports);
    let module = Module::new(&engine, binary.finish()).unwrap();
    let runtime = process::Runtime::new(engine.clone(), module.clone(), Vec::new()).unwrap();
    let cancel = Arc::new(Cancellation::default());
    let net = crate::net::Net::new();
    let stdio = Stdio::inherited();
    let mut wasi = wasmtime_wasi::WasiCtxBuilder::new();
    stdio.install(&mut wasi, cancel.clone());
    let processes = process::Processes::new(runtime.clone(), stdio, net.notify(), cancel.clone());
    let host = Host {
        nested: crate::nested::State::default(),
        wasi: wasi.build_p1(),
        watches: crate::fs_watch::Watches::new(net.notify()),
        net,
        memory: None,
        trace: false,
        processes,
        shm: None,
        limits: StoreLimitsBuilder::new().build(),
        functions: Vec::new(),
        cancel,
        cwd: "/".into(),
    };
    let mut linker = Linker::new(&engine);
    add_imports(&mut linker).unwrap();
    let mut store = Store::new(&engine, host);
    let instance = linker.instantiate(&mut store, &module).unwrap();
    let route = instance
        .get_typed_func::<u32, i32>(&mut store, "route_group")
        .unwrap();
    assert_eq!(route.call(&mut store, 1).unwrap(), Errno::NotSup.result());
    let group = group();
    let owner = member(&group, 1);
    let (_, pin) = pinned(&owner);
    store.data_mut().shm = Some(owner);
    assert_eq!(route.call(&mut store, pin.0).unwrap(), 0);
    assert_eq!(route.call(&mut store, pin.0).unwrap(), Errno::BadF.result());
    let owner = store.data_mut().shm.take().unwrap();
    drop(store);
    runtime.shutdown();
    owner.physical_stopped();
    assert_eq!(group.snapshot().regions, 0);
    assert_eq!(group.snapshot().pins, 0);
}

#[test]
fn pin_exhaustion_never_reuses_ids_or_changes_accounting() {
    let group = group();
    let owner = member(&group, 1);
    let (region, stale) = pinned(&owner);
    assert_eq!(shm_unpin(&owner, stale.0), 0);
    group.inner.lock().next_pin = u64::from(u32::MAX) - 1;
    let penultimate = owner.group.pin(owner.member, region.handle).unwrap();
    assert_eq!(penultimate.0, u32::MAX - 1);
    assert_eq!(shm_unpin(&owner, penultimate.0), 0);
    let last = owner.group.pin(owner.member, region.handle).unwrap();
    assert_eq!(last.0, u32::MAX);
    assert_eq!(shm_route_group(&owner, last.0), 0);
    let before = group.snapshot();
    assert_eq!(shm_unpin(&owner, stale.0), Errno::BadF.result());
    assert_eq!(
        owner.group.pin(owner.member, region.handle),
        Err(Errno::Again)
    );
    assert_eq!(group.snapshot(), before);
    assert_eq!(group.inner.lock().regions[&region.handle].pins, 1);
    assert_eq!(shm_unpin(&owner, last.0), 0);
    let before = group.snapshot();
    group.store32(0, 123).unwrap();
    assert_eq!(shm_pin(&owner, region.handle.0, 0), Errno::Again.result());
    assert_eq!(group.load32(0).unwrap(), 123);
    assert_eq!(group.snapshot(), before);
    assert_eq!(group.inner.lock().next_pin, u64::from(u32::MAX) + 1);
}

#[test]
fn region_exhaustion_precedes_chunk_reservation_and_budget_charge() {
    let budget = GroupBackingBudget::default();
    let group =
        MemoryGroup::new(&Engine::default(), GroupPolicy::default(), budget.clone()).unwrap();
    let owner = member(&group, 1);
    let stale = owner.group.create(owner.member, 64, 16).unwrap();
    owner.group.detach(owner.member, stale.handle).unwrap();
    group.inner.lock().next_handle = u64::from(u32::MAX) - 1;
    let penultimate = owner.group.create(owner.member, 64, 16).unwrap();
    assert_eq!(penultimate.handle.0, u32::MAX - 1);
    owner
        .group
        .detach(owner.member, penultimate.handle)
        .unwrap();
    let last = owner.group.create(owner.member, 64, 16).unwrap();
    assert_eq!(last.handle.0, u32::MAX);
    assert_eq!(
        owner.group.attach(owner.member, stale.handle),
        Err(Errno::BadF)
    );
    assert_eq!(
        owner.group.attach(owner.member, penultimate.handle),
        Err(Errno::BadF)
    );
    let before = group.snapshot();
    let charge = budget.committed_bytes();
    let peak = budget.peak_bytes();
    assert_eq!(
        owner.group.create(owner.member, PAGE_BYTES * 4, 16),
        Err(Errno::Again)
    );
    assert_eq!(
        owner.group.create_reservation(owner.member, 1, 16),
        Err(Errno::Again)
    );
    assert_eq!(group.snapshot(), before);
    assert_eq!(budget.committed_bytes(), charge);
    assert_eq!(budget.peak_bytes(), peak);
    owner.group.detach(owner.member, last.handle).unwrap();
    let before = group.snapshot();
    let free = group.inner.lock().free.clone();
    group.store32(0, 123).unwrap();
    assert_eq!(shm_create(&owner, 64, 16, 0), Errno::Again.result());
    assert_eq!(group.load32(0).unwrap(), 123);
    assert_eq!(group.snapshot(), before);
    assert_eq!(group.inner.lock().free, free);
    assert_eq!(group.inner.lock().next_handle, u64::from(u32::MAX) + 1);
}
