use super::*;

fn member(parent: &Processes, kind: ProcessKind) -> Processes {
    let admission = parent
        .runtime
        .admit_fixture(parent.pid, kind, Arc::default())
        .unwrap();
    Processes::new(
        admission,
        Stdio {
            fds: Descriptors::new(),
            memory_limit: stdio::DEFAULT_MEMORY_LIMIT,
        },
        parent.notify.clone(),
    )
}

#[test]
fn root_consumes_one_real_id_once_and_queries_never_allocate() {
    let root = processes();
    assert_eq!(root.pid, 0);
    assert_eq!(root.process_identity().pair(), (1, 0));
    assert_eq!(root.kill(0, 0), 0);
    assert_eq!(root.kill(1, 0), SRCH);
    assert!(matches!(
        root.runtime.admit_root(Arc::default()),
        Err(INVAL)
    ));
    for _ in 0..10 {
        assert_eq!(root.process_identity().pair(), (1, 0));
    }
    let first = member(&root, ProcessKind::Process);
    assert_eq!((first.pid, first.process_identity().pair()), (2, (2, 1)));
    let second = member(&root, ProcessKind::Process);
    assert_eq!((second.pid, second.process_identity().pair()), (3, (3, 1)));
    assert!(
        !root
            .runtime
            .state
            .lock()
            .unwrap()
            .processes
            .contains_key(&1)
    );
}

#[test]
fn thread_first_reserves_execution_two_without_allocating_a_second_process_id() {
    let root = processes();
    let thread = member(&root, ProcessKind::Thread);
    assert_eq!((thread.pid, thread.process_identity().pair()), (2, (1, 0)));
    let child = member(&root, ProcessKind::Process);
    assert_eq!((child.pid, child.process_identity().pair()), (3, (3, 1)));
    assert!(matches!(
        root.runtime.state.lock().unwrap().processes[&thread.pid].membership,
        Membership::Thread(_)
    ));
}

#[test]
fn nonroot_nested_members_keep_creation_ancestry_after_leader_collection() {
    let root = processes();
    let leader = member(&root, ProcessKind::Process);
    let thread = member(&leader, ProcessKind::Thread);
    let nested = member(&thread, ProcessKind::Thread);
    assert_ne!(thread.pid, leader.pid);
    assert_ne!(nested.pid, thread.pid);
    assert_eq!(thread.process_identity().pair(), (2, 1));
    assert_eq!(nested.process_identity().pair(), (2, 1));
    assert_eq!(thread.kill(leader.pid, 0), PERM);
    root.runtime
        .state
        .lock()
        .unwrap()
        .complete(leader.pid, FinalOutcome::Exit(0));
    assert_eq!(root.wait(leader.pid), Ok(FinalOutcome::Exit(0)));
    assert!(
        !root
            .runtime
            .state
            .lock()
            .unwrap()
            .processes
            .contains_key(&leader.pid)
    );
    assert_eq!(thread.process_identity().pair(), (2, 1));
    let child = member(&nested, ProcessKind::Process);
    assert_eq!(child.process_identity().pair(), (child.pid, 2));
    assert_eq!(
        root.runtime.state.lock().unwrap().processes[&child.pid].parent,
        nested.pid
    );
    assert_eq!(thread.wait(child.pid), Err(CHILD));
    assert_eq!(leader.wait(child.pid), Err(CHILD));
    assert_eq!(nested.wait(child.pid), Err(AGAIN));
}

#[test]
fn admission_rejects_finished_cancelled_missing_and_stopping_callers_without_allocating() {
    let root = processes();
    let finished = member(&root, ProcessKind::Process);
    let cancelled = member(&root, ProcessKind::Thread);
    let selected = member(&root, ProcessKind::Process);
    root.runtime
        .state
        .lock()
        .unwrap()
        .complete(finished.pid, FinalOutcome::Exit(0));
    cancelled.cancel.kill(9);
    selected.cancel.select(FinalOutcome::Exit(23));
    let before = root.runtime.state.lock().unwrap().next;
    for caller in [finished.pid, cancelled.pid, selected.pid, 1999] {
        assert!(matches!(
            root.runtime
                .admit_fixture(caller, ProcessKind::Thread, Arc::default()),
            Err(SRCH)
        ));
    }
    assert_eq!(root.runtime.state.lock().unwrap().next, before);
    root.runtime.state.lock().unwrap().stopping = true;
    assert!(matches!(
        root.runtime
            .admit_fixture(0, ProcessKind::Process, Arc::default()),
        Err(PERM)
    ));
}

#[test]
fn simultaneous_ordinary_sibling_admission_uses_the_one_authoritative_allocator() {
    let root = processes();
    let members = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    root.runtime
                        .admit_fixture(0, ProcessKind::Process, Arc::default())
                        .unwrap()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    let mut ids = std::collections::HashSet::new();
    for admission in members {
        let child = Processes::new(
            admission,
            Stdio {
                fds: Descriptors::new(),
                memory_limit: stdio::DEFAULT_MEMORY_LIMIT,
            },
            root.notify.clone(),
        );
        assert!(ids.insert(child.pid));
        assert_eq!(child.process_identity().pair(), (child.pid, 1));
    }
    assert_eq!(ids.len(), 8);
    assert!(!ids.contains(&1));
}

#[test]
fn native_thread_creation_failure_rolls_back_records_and_inherited_descriptors() {
    let mut root = processes();
    Arc::get_mut(&mut root.runtime).unwrap().thread_stack = usize::MAX / 2;
    let [read, write] = root.pipe().unwrap();
    let before = {
        let state = root.runtime.state.lock().unwrap();
        (
            state.processes.len(),
            state.parents.len(),
            state.jobs.len(),
            state.next,
        )
    };
    let result = root.spawn(&request(
        "/bin/bun",
        serde_json::json!([{"child":1,"parent":write}]),
    ));
    assert_eq!(result, AGAIN);
    let after = {
        let state = root.runtime.state.lock().unwrap();
        (
            state.processes.len(),
            state.parents.len(),
            state.jobs.len(),
            state.next,
        )
    };
    assert_eq!(after, (before.0, before.1, before.2, before.3 + 1));
    root.close(write);
    assert_eq!(root.read(read, &mut [0]), 0);
}

#[test]
fn last_signed_id_is_admitted_once_and_never_wraps_or_reuses_a_collected_id() {
    let root = processes();
    root.runtime.state.lock().unwrap().next = i32::MAX as u32;
    let last = member(&root, ProcessKind::Process);
    assert_eq!(last.pid, i32::MAX);
    assert_eq!(last.process_identity().pair(), (i32::MAX, 1));
    root.runtime
        .state
        .lock()
        .unwrap()
        .complete(last.pid, FinalOutcome::Exit(0));
    root.wait(last.pid).unwrap();
    assert!(matches!(
        root.runtime
            .admit_fixture(0, ProcessKind::Process, Arc::default()),
        Err(AGAIN)
    ));
}

fn identity_guest(engine: &wasmtime::Engine) -> wasmtime::Module {
    use wasm_encoder::{
        CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
        ImportSection, Instruction as I, MemArg, MemorySection, MemoryType, Module, TypeSection,
        ValType,
    };
    let mut types = TypeSection::new();
    types.ty().function([], [ValType::I32]);
    types.ty().function([ValType::I32; 4], [ValType::I32]);
    types.ty().function([], []);
    let mut imports = ImportSection::new();
    for name in ["process_id", "parent_process_id", "getpid"] {
        imports.import("runtime_proc", name, EntityType::Function(0));
    }
    imports.import(
        "wasi_snapshot_preview1",
        "fd_write",
        EntityType::Function(1),
    );
    let mut functions = FunctionSection::new();
    functions.function(2);
    let mut memory = MemorySection::new();
    memory.memory(MemoryType {
        minimum: 1,
        maximum: None,
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("_start", ExportKind::Func, 4);
    let mut body = Function::new([]);
    let word = MemArg {
        offset: 0,
        align: 2,
        memory_index: 0,
    };
    for index in 0..3 {
        body.instruction(&I::I32Const(index * 4));
        body.instruction(&I::Call(index as u32));
        body.instruction(&I::I32Store(word));
    }
    for (address, value) in [(16, 0), (20, 12)] {
        body.instruction(&I::I32Const(address));
        body.instruction(&I::I32Const(value));
        body.instruction(&I::I32Store(word));
    }
    for value in [1, 16, 1, 24] {
        body.instruction(&I::I32Const(value));
    }
    body.instruction(&I::Call(3));
    body.instruction(&I::Drop);
    body.instruction(&I::End);
    let mut code = CodeSection::new();
    code.function(&body);
    let mut module = Module::new();
    module
        .section(&types)
        .section(&imports)
        .section(&functions)
        .section(&memory)
        .section(&exports)
        .section(&code);
    wasmtime::Module::new(engine, module.finish()).unwrap()
}

#[test]
fn actual_native_child_imports_match_its_handle_and_logical_parent_inside_a_nonroot_thread() {
    let root = processes();
    root.runtime
        .register_engine("quickjs", &identity_guest(&root.runtime.engine))
        .unwrap();
    let leader = member(&root, ProcessKind::Process);
    let mut thread = member(&leader, ProcessKind::Thread);
    let [read, write] = thread.pipe().unwrap();
    let pid = thread.spawn(&request(
        "/opt/bun/quickjs/bin/bun",
        serde_json::json!([{"child":1,"parent":write}]),
    ));
    assert!(pid > thread.pid);
    thread.close(write);
    assert_eq!(root.wait(pid), Err(CHILD));
    assert_eq!(leader.wait(pid), Err(CHILD));
    assert_eq!(completed(&thread, pid), FinalOutcome::Exit(0));
    let mut bytes = [0; 12];
    assert_eq!(thread.read(read, &mut bytes), 12);
    let words: Vec<_> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|word| i32::from_le_bytes(*word))
        .collect();
    assert_eq!(words, [pid, leader.pid, pid]);
    assert_eq!(thread.process_identity().pair(), (leader.pid, 1));
}
