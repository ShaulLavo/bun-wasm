use super::*;
use crate::guest::GuestMemory;
use crate::process::{self, Cancellation, FinalOutcome, Runtime, Stdio};
use std::sync::Arc;
use wasmtime::{Config, Engine, Memory, MemoryType, Module, StoreLimitsBuilder, WasmParams};

#[test]
fn bash_0bf_terminal_geometry_and_phase_status_contract() {
    use wasm_encoder::{
        CodeSection, EntityType, ExportKind, ExportSection, Function, FunctionSection,
        ImportSection, Instruction, TypeSection, ValType,
    };

    // WAT: imports columns/rows () -> i32 and phase (i32, i32) -> ().
    // observe(phase, status) calls phase, then returns columns and rows.
    let mut types = TypeSection::new();
    types.ty().function([], [ValType::I32]);
    types.ty().function([ValType::I32, ValType::I32], []);
    types
        .ty()
        .function([ValType::I32, ValType::I32], [ValType::I32, ValType::I32]);
    let mut imports = ImportSection::new();
    imports.import("shell_terminal", "columns", EntityType::Function(0));
    imports.import("shell_terminal", "rows", EntityType::Function(0));
    imports.import("shell_terminal", "phase", EntityType::Function(1));
    let mut functions = FunctionSection::new();
    functions.function(2);
    let mut exports = ExportSection::new();
    exports.export("observe", ExportKind::Func, 3);
    let mut observe = Function::new([]);
    for instruction in [
        Instruction::LocalGet(0),
        Instruction::LocalGet(1),
        Instruction::Call(2),
        Instruction::Call(0),
        Instruction::Call(1),
        Instruction::End,
    ] {
        observe.instruction(&instruction);
    }
    let mut code = CodeSection::new();
    code.function(&observe);
    let mut binary = wasm_encoder::Module::new();
    binary
        .section(&types)
        .section(&imports)
        .section(&functions)
        .section(&exports)
        .section(&code);

    let mut f = Fixture::new();
    add_shell_imports(&mut f.linker).unwrap();
    let module = Module::new(f.store.engine(), binary.finish()).unwrap();
    let instance = f.linker.instantiate(&mut f.store, &module).unwrap();
    let observe = instance
        .get_typed_func::<(i32, i32), (i32, i32)>(&mut f.store, "observe")
        .unwrap();
    for notification in [(1, 7), (2, 130), (1, 0)] {
        assert_eq!(observe.call(&mut f.store, notification).unwrap(), (80, 24));
        assert!(
            f.store.data().cancel.check().is_ok(),
            "A terminal phase/status notification must not cancel the native process"
        );
        assert_eq!(f.call("shell_terminal", "inherited_fd", 0), 0);
    }
}

#[test]
fn runtime_proc_inherited_fds_are_a_stable_launch_snapshot() {
    use wasm_encoder::{
        EntityType, ExportKind, ExportSection, ImportSection, TypeSection, ValType,
    };

    let mut types = TypeSection::new();
    types.ty().function([ValType::I32], [ValType::I32]);
    let mut imports = ImportSection::new();
    imports.import("runtime_proc", "inherited_fd", EntityType::Function(0));
    let mut exports = ExportSection::new();
    exports.export("inherited_fd", ExportKind::Func, 0);
    let mut binary = wasm_encoder::Module::new();
    binary.section(&types).section(&imports).section(&exports);
    let binary = binary.finish();

    let mut sparse = Stdio::inherited();
    let input = sparse.fds.remove(&0).unwrap();
    let output = sparse.fds.remove(&1).unwrap();
    sparse.fds.insert(17, input);
    sparse.fds.insert(i32::MAX, output);
    for (stdio, expected) in [(Stdio::inherited(), [0, 1, 2]), (sparse, [2, 17, i32::MAX])] {
        let mut f = Fixture::with_stdio(stdio);
        let module = Module::new(f.store.engine(), &binary).unwrap();
        let instance = f.linker.instantiate(&mut f.store, &module).unwrap();
        let inherited = instance
            .get_typed_func::<i32, i32>(&mut f.store, "inherited_fd")
            .unwrap();
        let before =
            [0, 1, 2, 3, -1, i32::MAX].map(|index| inherited.call(&mut f.store, index).unwrap());
        assert_eq!(
            before,
            [
                expected[0],
                expected[1],
                expected[2],
                process::NOENT,
                process::NOENT,
                process::NOENT
            ]
        );
        assert_eq!(f.store.data_mut().processes.close(expected[0]), 0);
        assert_eq!(f.store.data_mut().processes.renumber(expected[1], 23), 0);
        let after =
            [0, 1, 2, 3, -1, i32::MAX].map(|index| inherited.call(&mut f.store, index).unwrap());
        assert_eq!(
            after, before,
            "closing and renumbering descriptors must not change launch bindings"
        );
    }
}

struct Fixture {
    store: Store<Host>,
    linker: Linker<Host>,
    runtime: Arc<Runtime>,
    /// A shared fixture's group backing: fields drop in order, so it outlives `store`.
    _backing: Option<crate::shm::SharedMemoryLease>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.shutdown();
    }
}
impl Fixture {
    fn new() -> Self {
        Self::at(std::path::Path::new(env!("CARGO_MANIFEST_DIR")))
    }
    fn with_stdio(stdio: Stdio) -> Self {
        Self::with_memory_and_stdio(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
            false,
            stdio,
        )
    }
    /// The same imports over a memory group's shared memory.
    fn shared() -> Self {
        Self::with_memory(std::path::Path::new(env!("CARGO_MANIFEST_DIR")), true)
    }
    /// A private-memory fixture, then a shared-memory one.
    fn both() -> [Self; 2] {
        [Self::new(), Self::shared()]
    }
    fn at(directory: &std::path::Path) -> Self {
        Self::with_memory(directory, false)
    }
    fn with_memory(directory: &std::path::Path, shared: bool) -> Self {
        Self::with_memory_and_stdio(directory, shared, Stdio::inherited())
    }
    fn with_memory_and_stdio(directory: &std::path::Path, shared: bool, stdio: Stdio) -> Self {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config).unwrap();
        let module = Module::new(&engine,b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0a\x01\x06_start\0\0\x0a\x04\x01\x02\0\x0b").unwrap();
        let runtime =
            Runtime::new(engine.clone(), module, vec![(directory.into(), "/".into())]).unwrap();
        let net = crate::net::Net::new();
        let cancel = Arc::new(Cancellation::default());
        let mut wasi = wasmtime_wasi::WasiCtxBuilder::new();
        stdio.install(&mut wasi, cancel.clone());
        for (host, guest) in &runtime.dirs {
            wasi.preopened_dir(
                host,
                guest,
                wasmtime_wasi::DirPerms::all(),
                wasmtime_wasi::FilePerms::all(),
            )
            .unwrap();
        }
        let processes =
            process::Processes::new(runtime.clone(), stdio, net.notify(), cancel.clone());
        let watches = crate::fs_watch::Watches::new(net.notify());
        let mut store = Store::new(
            &engine,
            Host {
                wasi: wasi.build_p1(),
                watches,
                net,
                memory: None,
                trace: false,
                processes,
                shm: None,
                limits: StoreLimitsBuilder::new().build(),
                functions: Vec::new(),
                cancel,
                cwd: "/work/app".into(),
            },
        );
        store.set_epoch_deadline(1);
        let backing = shared.then(|| {
            let policy = crate::shm::GroupPolicy {
                maximum_pages: 8192,
                ..crate::shm::GroupPolicy::default()
            };
            let budget = crate::shm::GroupBackingBudget::default();
            crate::shm::MemoryGroup::new(&engine, policy, budget)
                .unwrap()
                .memory_lease()
        });
        let memory = match &backing {
            Some(lease) => GuestMemory::Shared(lease.clone()),
            None => {
                GuestMemory::Private(Memory::new(&mut store, MemoryType::new(1, None)).unwrap())
            }
        };
        store.data_mut().memory = Some(memory);
        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |host: &mut Host| &mut host.wasi)
            .unwrap();
        add_import(&mut linker, &mut store).unwrap();
        Self {
            store,
            linker,
            runtime,
            _backing: backing,
        }
    }
    fn call<P: WasmParams>(&mut self, module: &str, name: &str, args: P) -> i32 {
        let function = self
            .linker
            .get(&mut self.store, module, name)
            .unwrap()
            .into_func()
            .unwrap();
        function
            .typed::<P, i32>(&self.store)
            .unwrap()
            .call(&mut self.store, args)
            .unwrap()
    }

    fn memory(&self) -> GuestMemory {
        self.store.data().memory.clone().unwrap()
    }
    fn write(&mut self, ptr: usize, bytes: &[u8]) {
        self.memory().write(&mut self.store, ptr, bytes).unwrap();
    }
    fn bytes(&self, ptr: usize, len: usize) -> Vec<u8> {
        self.memory().read(&self.store, ptr..ptr + len).unwrap()
    }
    fn word(&self, ptr: usize) -> i32 {
        i32::from_le_bytes(self.bytes(ptr, 4).try_into().unwrap())
    }
    fn pipe(&mut self) -> [i32; 2] {
        assert_eq!(self.call("runtime_proc", "pipe", 0), 0);
        [self.word(0), self.word(4)]
    }
    fn iovec(&mut self, ptr: i32, len: i32) {
        self.write(32, &ptr.to_le_bytes());
        self.write(36, &len.to_le_bytes());
    }
}

#[test]
fn network_slots_have_no_child_or_signal_transport() {
    assert_eq!(SLOT_NAMES.len(), 18);
    assert_eq!(
        &SLOT_NAMES[12..],
        &[
            "shutdown",
            "local_addr",
            "lookup_start",
            "lookup_head",
            "listen_path",
            "connect_path"
        ]
    );
    assert!(
        SLOT_NAMES
            .iter()
            .all(|name| !name.starts_with("child_") && *name != "spawn" && *name != "signal")
    );
}

#[test]
fn lookup_sized_results_do_not_overwrite_small_buffers() {
    for mut f in Fixture::both() {
        let memory = f.memory();
        f.write(0, &[0x7f; 4]);
        let output = || Output::Bytes(b"abcd".to_vec());
        assert_eq!(put(&memory, &mut f.store, 0, 3, output()).unwrap(), 4);
        assert_eq!(f.bytes(0, 4), [0x7f; 4]);
        assert_eq!(put(&memory, &mut f.store, 0, 4, output()).unwrap(), 4);
        assert_eq!(f.bytes(0, 4), b"abcd");
    }
}

#[test]
fn lookup_start_rejects_invalid_utf8_before_allocating_a_handle() {
    let mut f = Fixture::new();
    f.write(1024, &[0xff]);
    let generation = f.store.data().net.notify().generation();
    let lookup_start = functions(&mut f.store)
        .into_iter()
        .nth(14)
        .unwrap()
        .typed::<(i32, i32, i32, i32), i32>(&f.store)
        .unwrap();

    assert_eq!(
        lookup_start.call(&mut f.store, (1024, 1, 0, 0)).unwrap(),
        crate::net::ERROR
    );
    assert!(matches!(
        f.store.data_mut().net.lookup_head(1),
        Output::Code(crate::net::BADF)
    ));
    assert_eq!(f.store.data().net.notify().generation(), generation);
    let error = match f.store.data_mut().net.error(0) {
        Output::Bytes(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        Output::Code(code) => panic!("expected handle-less lookup error, got {code}"),
    };
    assert_eq!(error["code"], "EINVAL");
    assert_eq!(error["syscall"], "getaddrinfo");
}

#[test]
fn runtime_pipe_and_preview1_io_close_and_renumber_share_descriptors() {
    for mut f in Fixture::both() {
        let [read, write] = f.pipe();
        f.write(128, b"abc");
        assert_eq!(f.call("runtime_proc", "write", (write, 128, 3)), 3);
        f.iovec(256, 8);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (read, 32, 1, 48)),
            0
        );
        assert_eq!(f.word(48), 3);
        assert_eq!(f.bytes(256, 3), b"abc");
        f.iovec(128, 3);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_write", (write, 32, 1, 48)),
            0
        );
        assert_eq!(f.word(48), 3);
        assert_eq!(f.call("runtime_proc", "read", (read, 256, 3)), 3);
        assert_eq!(f.bytes(256, 3), b"abc");
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (write, 19)),
            0
        );
        assert_eq!(
            f.call("runtime_proc", "write", (write, 128, 3)),
            process::BADF
        );
        assert_eq!(f.call("runtime_proc", "write", (19, 128, 3)), 3);
        assert_eq!(f.call("runtime_proc", "read", (read, 256, 3)), 3);
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", 19), 0);
        f.iovec(256, 8);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (read, 32, 1, 48)),
            0
        );
        assert_eq!(f.word(48), 0);
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", read), 0);
        assert_eq!(
            f.call("runtime_proc", "read", (read, 256, 3)),
            process::BADF
        );
    }
}

#[test]
fn stdio_binding_can_be_read_through_both_abis_without_buffer_loss() {
    for mut f in Fixture::both() {
        let [read, write] = f.pipe();
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (read, 0)),
            0
        );
        f.write(128, b"abcdef");
        assert_eq!(f.call("runtime_proc", "write", (write, 128, 6)), 6);
        f.iovec(256, 1);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (0, 32, 1, 48)),
            0
        );
        assert_eq!(f.bytes(256, 1), b"a");
        assert_eq!(f.call("runtime_proc", "read", (0, 256, 5)), 5);
        assert_eq!(f.bytes(256, 5), b"bcdef");
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_renumber", (0, 19)), 0);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (0, 32, 1, 48)),
            -process::BADF
        );
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", 19), 0);
        assert_eq!(
            f.call("runtime_proc", "write", (write, 128, 1)),
            process::PIPE
        );
    }
}

#[test]
fn process_import_faults_return_errno_before_resource_changes_or_job_reap() {
    for mut f in Fixture::both() {
        assert_eq!(f.call("runtime_proc", "pipe", 65535), process::FAULT);
        let [read, write] = f.pipe();
        assert_eq!(read, process::FIRST_HANDLE);
        assert_eq!(write, read + 1);
        assert_eq!(
            f.call("runtime_proc", "poll", (0, -1, 0, 64)),
            process::FAULT
        );
        let request = serde_json::to_vec(
        &serde_json::json!({"executable":"/bin/bun","argv":[],"env":{},"cwd":"/","job":0,"fds":[]}),
    )
    .unwrap();
        f.write(512, &request);
        let pid = f.call("runtime_proc", "spawn", (512, request.len() as i32));
        assert!(pid > 0);
        let job = f.call("runtime_proc", "job_of", pid);
        assert_eq!(
            f.call("runtime_proc", "wait_job", (job, 1, 65532)),
            process::FAULT
        );
        assert_eq!(f.call("runtime_proc", "wait_job", (job, 0, 80)), 0);
        assert_eq!(f.word(80), 0);
        assert_eq!(f.word(84), 0);
        assert_eq!(f.call("runtime_proc", "wait", (pid, 88)), process::CHILD);
        assert_eq!(
            f.call("runtime_proc", "wait_job", (job, 1, 80)),
            process::CHILD
        );
    }
}

#[test]
fn signal_import_uses_wasi_errno_and_unwinds_default_death() {
    let mut f = Fixture::new();
    assert_eq!(f.call("runtime_proc", "signal", (32, 0)), process::INVAL);
    assert_eq!(f.call("runtime_proc", "signal", (19, 3)), process::NOTSUP);
    for ignored in [17, 18, 23, 28] {
        assert_eq!(f.call("runtime_proc", "signal", (ignored, 3)), 0);
        assert!(f.store.data().cancel.check().is_ok());
    }
    let function = f
        .linker
        .get(&mut f.store, "runtime_proc", "signal")
        .unwrap()
        .into_func()
        .unwrap()
        .typed::<(i32, i32), i32>(&f.store)
        .unwrap();
    assert!(function.call(&mut f.store, (15, 3)).is_err());
    assert_eq!(
        f.store.data().cancel.select(FinalOutcome::Exit(1)),
        FinalOutcome::Signal(15)
    );
}

#[test]
fn restoring_default_preserves_standard_ignored_signals() {
    let mut f = Fixture::new();
    for signal in [17, 18, 23, 28] {
        assert_eq!(f.call("runtime_proc", "signal", (signal, 2)), 0);
        assert_eq!(f.call("runtime_proc", "signal", (signal, 3)), 0);
        assert!(f.store.data().cancel.interrupted());
        assert_eq!(f.call("runtime_proc", "signal", (signal, 0)), 0);
        assert!(!f.store.data().cancel.interrupted());
        assert_eq!(f.call("runtime_proc", "signal", (signal, 3)), 0);
        assert!(f.store.data().cancel.check().is_ok());
    }
    for signal in [32, 33, 65, -1] {
        assert_eq!(
            f.call("runtime_proc", "signal", (signal, 0)),
            process::INVAL
        );
    }
    for signal in 19..=22 {
        assert_eq!(
            f.call("runtime_proc", "signal", (signal, 0)),
            process::NOTSUP
        );
    }
}

impl Fixture {
    fn open_manifest(&mut self, directory: i32) -> i32 {
        self.write(1024, b"Cargo.toml");
        assert_eq!(
            self.call(
                "wasi_snapshot_preview1",
                "path_open",
                (directory, 0, 1024, 10, 0, 2i64, 0i64, 0, 1080)
            ),
            0
        );
        self.word(1080)
    }
}

#[test]
fn inherited_fd_three_replaces_the_preopen_without_relocation_or_revival() {
    let mut f = Fixture::new();
    let [read, write] = f.store.data_mut().processes.pipe().unwrap();
    assert_eq!(f.store.data_mut().processes.renumber(read, 3), 0);
    // Shared limitation, tracked by the Waffle descriptor-collision design
    // follow-up: inheriting fd3 replaces the root preopen, so libc's scan stops
    // at fd3. Change both hosts together when Waffle's policy changes.
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_prestat_get", (3, 256)),
        -process::BADF
    );
    for fd in [4, 5, 6] {
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_prestat_get", (fd, 256)),
            0
        );
    }
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_prestat_get", (7, 256)),
        -process::BADF
    );
    f.write(1024, b"Cargo.toml");
    for fd in [3, 7] {
        assert_eq!(
            f.call(
                "wasi_snapshot_preview1",
                "path_open",
                (fd, 0, 1024, 10, 0, 2i64, 0i64, 0, 1080)
            ),
            -process::BADF
        );
    }
    assert_eq!(f.store.data_mut().processes.write(write, b"x"), 1);
    let mut byte = [0];
    assert_eq!(f.store.data().processes.read(3, &mut byte), 1);
    assert_eq!(byte, *b"x");
    assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", 3), 0);
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_fdstat_get", (3, 256)),
        -process::BADF
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_prestat_get", (3, 256)),
        -process::BADF
    );
    assert_eq!(
        f.store.data_mut().processes.write(write, b"x"),
        process::PIPE
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_prestat_get", (7, 256)),
        -process::BADF
    );
}

#[test]
fn engine_preopens_form_a_contiguous_libc_scan_ending_at_ebadf() {
    let mut f = Fixture::new();
    for name in ["quickjs", "jsc"] {
        f.runtime.register_engine(name, &f.runtime.module).unwrap();
    }
    // wasi-libc's actual scan accepts success, stops at BADF, and aborts on
    // every other errno. Check names too, not merely successful descriptors.
    for (fd, expected) in [(3, "/"), (4, "/bin"), (5, "/opt/bun"), (6, "/usr/bin")] {
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_prestat_get", (fd, 256)),
            0
        );
        let len = f.word(260);
        assert_eq!(
            f.call(
                "wasi_snapshot_preview1",
                "fd_prestat_dir_name",
                (fd, 512, len)
            ),
            0
        );
        assert_eq!(f.bytes(512, len as usize), expected.as_bytes());
    }
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_prestat_get", (7, 256)),
        -process::BADF
    );
    // Open non-preopen descriptors also return BADF, exactly as in Waffle.
    let file = f.open_manifest(3);
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_prestat_get", (file, 256)),
        -process::BADF
    );
}

#[test]
fn renumber_files_and_streams_replaces_the_destination_without_hidden_entries() {
    for mut f in Fixture::both() {
        let [read, write] = f.pipe();
        let file = f.open_manifest(3);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (read, 9)),
            0
        );
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (file, 9)),
            0
        );
        assert_eq!(
            f.call("runtime_proc", "write", (write, 0, 1)),
            process::PIPE
        );
        f.iovec(2048, 8);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (9, 32, 1, 48)),
            0
        );
        assert_eq!(f.bytes(2048, 8), b"[package");
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", 9), 0);
        let [read, _write] = f.pipe();
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (read, 3)),
            0
        );
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", 3), 0);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_prestat_get", (3, 256)),
            -process::BADF
        );
    }
}

#[test]
fn preview1_poll_reports_process_readiness_hangup_and_regular_files() {
    for mut f in Fixture::both() {
        let [read, write] = f.pipe();
        let file = f.open_manifest(3);
        let mut subscriptions = [0u8; 96];
        subscriptions[..8].copy_from_slice(&41u64.to_le_bytes());
        subscriptions[8] = 1;
        subscriptions[16..20].copy_from_slice(&read.to_le_bytes());
        subscriptions[48..56].copy_from_slice(&42u64.to_le_bytes());
        subscriptions[56] = 1;
        subscriptions[64..68].copy_from_slice(&file.to_le_bytes());
        f.write(512, &subscriptions);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "poll_oneoff", (512, 2048, 2, 128)),
            0
        );
        assert_eq!(f.word(128), 1);
        assert_eq!(f.word(2048), 42);
        assert_eq!(f.word(2056) & 0xffff, 0);
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", write), 0);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "poll_oneoff", (512, 2048, 1, 128)),
            0
        );
        assert_eq!(f.word(128), 1);
        assert_eq!(f.word(2048), 41);
        assert_eq!(f.bytes(2072, 2), &1u16.to_le_bytes());
        assert_eq!(f.bytes(512, 96), subscriptions);
    }
}

#[test]
fn imports_can_find_memory_during_a_wasm_start_section() {
    fn section(wasm: &mut Vec<u8>, id: u8, bytes: &[u8]) {
        assert!(bytes.len() < 128);
        wasm.extend_from_slice(&[id, bytes.len() as u8]);
        wasm.extend_from_slice(bytes);
    }
    let mut f = Fixture::new();
    let mut wasm = b"\0asm\x01\0\0\0".to_vec();
    section(&mut wasm, 1, &[2, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]);
    let mut import = vec![1, 22];
    import.extend_from_slice(b"wasi_snapshot_preview1");
    import.push(13);
    import.extend_from_slice(b"fd_fdstat_get");
    import.extend_from_slice(&[0, 0]);
    section(&mut wasm, 2, &import);
    section(&mut wasm, 3, &[1, 1]);
    section(&mut wasm, 5, &[1, 0, 1]);
    section(
        &mut wasm,
        7,
        &[1, 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 0],
    );
    section(&mut wasm, 8, &[1]);
    section(
        &mut wasm,
        10,
        &[1, 9, 0, 0x41, 1, 0x41, 16, 0x10, 0, 0x1a, 0x0b],
    );
    let module = Module::new(f.store.engine(), wasm).unwrap();
    f.store.data_mut().memory = None;
    let instance = f.linker.instantiate(&mut f.store, &module).unwrap();
    let memory = instance.get_memory(&mut f.store, "memory").unwrap();
    assert_eq!(
        &memory.data(&f.store)[24..32],
        &((1u64 << 6) | (1u64 << 27)).to_le_bytes()
    );
}

#[test]
fn virtual_files_survive_stdio_replacement_high_handles_and_allocator_reuse() {
    let mut f = Fixture::new();
    for fd in 0i32..3 {
        let file = f.open_manifest(3);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (file, fd)),
            0
        );
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_renumber", (fd, fd)), 0);
        f.iovec(2048, 8);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (fd, 32, 1, 48)),
            0
        );
        assert_eq!(f.bytes(2048, 8), b"[package");
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", fd), 0);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_fdstat_get", (fd, 256)),
            -process::BADF
        );
    }
    let file = f.open_manifest(3);
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "fd_renumber",
            (file, process::FIRST_HANDLE)
        ),
        0
    );
    let [read, _write] = f.pipe();
    assert!(read > process::FIRST_HANDLE);
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_close", process::FIRST_HANDLE),
        0
    );
    let first = f.open_manifest(3);
    assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", first), 0);
    let reused = f.open_manifest(3);
    assert_eq!(first, reused);
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_renumber", (reused, reused)),
        0
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_renumber", (read, read)),
        0
    );
}

#[test]
fn moved_directory_translates_all_path_handle_positions_without_stream_aliases() {
    let mut f = Fixture::new();
    let [read, _write] = f.pipe();
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_renumber", (read, 7)),
        0
    );
    assert_eq!(f.call("wasi_snapshot_preview1", "fd_renumber", (3, 11)), 0);
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "fd_prestat_dir_name",
            (11, 256, 16)
        ),
        0
    );
    assert_eq!(f.bytes(256, 1), b"/");
    let file = f.open_manifest(11);
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_filestat_get", (file, 2048)),
        0
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_fdstat_get", (file, 256)),
        0
    );
    f.write(1024, b"Cargo.toml");
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_filestat_get",
            (11, 0, 1024, 10, 2048)
        ),
        0
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_link",
            (11, 0, 1024, 10, 7, 1024, 10)
        ),
        -process::BADF
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_link",
            (7, 0, 1024, 10, 11, 1024, 10)
        ),
        -process::BADF
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_rename",
            (11, 1024, 10, 7, 1024, 10)
        ),
        -process::BADF
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_rename",
            (7, 1024, 10, 11, 1024, 10)
        ),
        -process::BADF
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_symlink",
            (1024, 10, 7, 1024, 10)
        ),
        -process::BADF
    );
    for name in ["fd_datasync", "fd_sync"] {
        assert_eq!(f.call("wasi_snapshot_preview1", name, 7), -process::BADF);
    }
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_advise", (7, 0i64, 0i64, 0)),
        -process::BADF
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_allocate", (7, 0i64, 0i64)),
        -process::BADF
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_seek", (7, 0i64, 0, 256)),
        -process::BADF
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_tell", (7, 256)),
        -process::BADF
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "fd_readdir",
            (7, 2048, 64, 0i64, 256)
        ),
        -process::BADF
    );
    assert_eq!(
        f.call("wasi_snapshot_preview1", "fd_fdstat_set_flags", (7, 0)),
        -process::BADF
    );
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "fd_fdstat_set_rights",
            (7, 0i64, 0i64)
        ),
        -process::BADF
    );
}

#[test]
fn preview1_poll_preserves_duplicate_streams_unknown_handles_and_relative_clocks() {
    let mut f = Fixture::new();
    let [read, write] = f.pipe();
    let dup = f.call("runtime_proc", "dup", read);
    f.write(256, b"x");
    assert_eq!(f.call("runtime_proc", "write", (write, 256, 1)), 1);
    let mut subscriptions = [0u8; 144];
    for (index, fd) in [read, dup, 99].into_iter().enumerate() {
        let at = index * 48;
        subscriptions[at..at + 8].copy_from_slice(&(index as u64 + 51).to_le_bytes());
        subscriptions[at + 8] = 1;
        subscriptions[at + 16..at + 20].copy_from_slice(&fd.to_le_bytes());
    }
    f.write(512, &subscriptions);
    assert_eq!(
        f.call("wasi_snapshot_preview1", "poll_oneoff", (512, 2048, 3, 128)),
        0
    );
    assert_eq!(f.word(128), 3);
    assert_eq!(f.word(2048), 51);
    assert_eq!(f.word(2080), 52);
    assert_eq!(f.word(2112), 53);
    assert_eq!(f.bytes(2120, 2), &8u16.to_le_bytes());
    assert_eq!(f.bytes(512, 144), subscriptions);
    let mut clock = [0u8; 48];
    clock[..8].copy_from_slice(&61u64.to_le_bytes());
    clock[16..20].copy_from_slice(&1u32.to_le_bytes());
    clock[24..32].copy_from_slice(&10_000_000u64.to_le_bytes());
    f.write(512, &clock);
    let started = std::time::Instant::now();
    assert_eq!(
        f.call("wasi_snapshot_preview1", "poll_oneoff", (512, 2048, 1, 128)),
        0
    );
    assert!(started.elapsed() >= std::time::Duration::from_millis(5));
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(f.word(128), 1);
    assert_eq!(f.word(2048), 61);
    assert_eq!(f.bytes(2056, 2), &[0, 0]);
    assert_eq!(f.bytes(512, 48), clock);
}

#[test]
fn local_file_stdio_shares_offsets_between_both_abis_in_both_first_use_orders() {
    let expected = include_bytes!("../../Cargo.toml");
    for process_first in [false, true] {
        let mut f = Fixture::new();
        for fd in 0i32..3 {
            let file = f.open_manifest(3);
            assert_eq!(
                f.call("wasi_snapshot_preview1", "fd_renumber", (file, fd)),
                0
            );
            f.iovec(2048, 8);
            let iovec = f.bytes(32, 8).to_vec();
            for index in 0..3 {
                if (index % 2 == 0) == process_first {
                    assert_eq!(f.call("runtime_proc", "read", (fd, 2048, 8)), 8);
                } else {
                    assert_eq!(
                        f.call("wasi_snapshot_preview1", "fd_read", (fd, 32, 1, 48)),
                        0
                    );
                    assert_eq!(f.word(48), 8);
                }
                assert_eq!(f.bytes(2048, 8), &expected[index * 8..index * 8 + 8]);
                assert_eq!(f.bytes(32, 8), iovec);
            }
            // Async fs.read(0) waits with this ABI if a filesystem returns AGAIN.
            // Native files are synchronous, hence immediately ready, even at EOF.
            let mut subscriptions = [0u8; 32];
            for index in 0..2 {
                let at = index * 16;
                subscriptions[at..at + 4].copy_from_slice(&(index as u32).to_le_bytes());
                subscriptions[at + 4..at + 8].copy_from_slice(&fd.to_le_bytes());
                subscriptions[at + 8..at + 16].copy_from_slice(&(index as u64 + 101).to_le_bytes());
            }
            f.write(512, &subscriptions);
            assert_eq!(f.call("runtime_proc", "poll", (512, 2, 0, 2048)), 2);
            assert_eq!(f.word(2048), 101);
            assert_eq!(f.word(2064), 102);
            assert_eq!(f.bytes(512, 32), subscriptions);
            assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", fd), 0);
            assert_eq!(f.call("runtime_proc", "read", (fd, 2048, 8)), process::BADF);
        }
    }
}

#[test]
fn local_file_writes_share_offsets_without_modifying_guest_iovecs() {
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
            assert!(!self.0.exists());
        }
    }
    let directory =
        std::env::temp_dir().join(format!("bun-wasm-native-file-{}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let scratch = Scratch(directory);
    for shared in [false, true] {
        std::fs::write(scratch.0.join("output"), b"").unwrap();
        let mut f = Fixture::with_memory(&scratch.0, shared);
        f.write(1024, b"output");
        assert_eq!(
            f.call(
                "wasi_snapshot_preview1",
                "path_open",
                (3, 0, 1024, 6, 0, 64i64, 0i64, 0, 1080)
            ),
            0
        );
        let file = f.word(1080);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (file, 1)),
            0
        );
        f.write(256, b"abc");
        f.iovec(256, 3);
        let iovec = f.bytes(32, 8).to_vec();
        assert_eq!(f.call("runtime_proc", "write", (1, 256, 3)), 3);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_write", (1, 32, 1, 48)),
            0
        );
        assert_eq!(f.word(48), 3);
        assert_eq!(f.call("runtime_proc", "write", (1, 256, 3)), 3);
        assert_eq!(f.bytes(32, 8), iovec);
        assert_eq!(
            f.call("runtime_proc", "write", (1, 65535, 3)),
            process::FAULT
        );
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", 1), 0);
        assert_eq!(
            std::fs::read(scratch.0.join("output")).unwrap(),
            b"abcabcabc"
        );
    }
}

#[test]
fn zero_page_exported_memory_does_not_prevent_descriptor_initialization() {
    let mut f = Fixture::new();
    let module = Module::new(f.store.engine(), b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x05\x03\x01\0\0\x07\x13\x02\x06memory\x02\0\x06_start\0\0\x0a\x04\x01\x02\0\x0b").unwrap();
    let instance = f.linker.instantiate(&mut f.store, &module).unwrap();
    f.store.data_mut().memory = instance
        .get_memory(&mut f.store, "memory")
        .map(GuestMemory::Private);
    process::wasi::initialize(&f.linker, &mut f.store).unwrap();
    instance
        .get_typed_func::<(), ()>(&mut f.store, "_start")
        .unwrap()
        .call(&mut f.store, ())
        .unwrap();
}

#[test]
fn access_import_validation_never_allocates_a_request_on_invalid_input() {
    let mut f = Fixture::new();
    f.write(1024, b"/bin/bun");
    f.write(2048, b"/");
    for mode in [0, 2, 3, -1] {
        assert_eq!(
            f.call("runtime_proc", "access_start", (1024, 8, 2048, 1, mode)),
            process::INVAL
        );
    }
    for (path, cwd) in [
        (b"".as_slice(), b"/".as_slice()),
        (b"a\0b", b"/"),
        (b"bun", b""),
        (b"bun", b"bin"),
        (b"bun", b"/a\0b"),
        (&[255], b"/"),
        (b"bun", &[255]),
    ] {
        f.write(1024, path);
        f.write(2048, cwd);
        assert_eq!(
            f.call(
                "runtime_proc",
                "access_start",
                (1024, path.len() as i32, 2048, cwd.len() as i32, 1)
            ),
            process::INVAL
        );
    }
    assert_eq!(
        f.call("runtime_proc", "access_start", (65536, 1, 2048, 1, 1)),
        process::FAULT
    );
    assert_eq!(
        f.call("runtime_proc", "access_start", (1024, 1, 65536, 1, 1)),
        process::FAULT
    );
    assert_eq!(f.call("runtime_proc", "access_take", 1), process::BADF);
    assert_eq!(f.call("runtime_proc", "access_cancel", 1), process::BADF);
    f.write(1024, b"/bin/bun");
    f.write(2048, b"/");
    let id = f.call("runtime_proc", "access_start", (1024, 8, 2048, 1, 1));
    assert_eq!(id, 1);
    // Mutating the guest strings after submission cannot alter the query.
    f.write(1024, b"/missing");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let result = f.call("runtime_proc", "access_take", id);
        if result != process::AGAIN {
            assert_eq!(result, 0);
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(f.call("runtime_proc", "access_cancel", id), process::BADF);
    let id = f.call("runtime_proc", "access_start", (1024, 8, 2048, 1, 1));
    assert_eq!(f.call("runtime_proc", "access_cancel", id), 0);
    assert_eq!(f.call("runtime_proc", "access_take", id), process::BADF);
}

#[test]
fn engine_files_are_visible_to_wasi_metadata_open_and_readdir() {
    for mut f in Fixture::both() {
        // root is fd 3, /bin fd 4, /opt/bun fd 5.
        for path in ["bun", "node"] {
            f.write(1024, path.as_bytes());
            assert_eq!(
                f.call(
                    "wasi_snapshot_preview1",
                    "path_filestat_get",
                    (4, 0, 1024, path.len() as i32, 2048)
                ),
                0
            );
            assert_eq!(f.bytes(2064, 1), &[4]); // regular file
        }
        assert_eq!(
            f.call(
                "wasi_snapshot_preview1",
                "fd_readdir",
                (4, 2048, 1024, 0i64, 128)
            ),
            0
        );
        let count = f.word(128) as usize;
        let directory = f.bytes(2048, count);
        assert!(directory.windows(3).any(|name| name == b"bun"));
        assert!(directory.windows(4).any(|name| name == b"node"));
        for (engine, paths) in [
            ("quickjs", ["quickjs/bin/bun", "quickjs/bin/node"]),
            ("jsc", ["jsc/bin/bun", "jsc/bin/node"]),
        ] {
            for path in paths {
                f.write(1024, path.as_bytes());
                assert_eq!(
                    f.call(
                        "wasi_snapshot_preview1",
                        "path_filestat_get",
                        (5, 0, 1024, path.len() as i32, 2048)
                    ),
                    -process::NOENT
                );
            }
            f.runtime
                .register_engine(engine, &f.runtime.module)
                .unwrap();
            for path in paths {
                f.write(1024, path.as_bytes());
                assert_eq!(
                    f.call(
                        "wasi_snapshot_preview1",
                        "path_filestat_get",
                        (5, 0, 1024, path.len() as i32, 2048)
                    ),
                    0
                );
                assert_eq!(f.bytes(2064, 1), &[4]);
                assert_eq!(
                    f.call(
                        "wasi_snapshot_preview1",
                        "path_open",
                        (5, 0, 1024, path.len() as i32, 0, 2i64, 0i64, 0, 1080)
                    ),
                    0
                );
                let fd = f.word(1080);
                assert_eq!(
                    f.call("wasi_snapshot_preview1", "fd_filestat_get", (fd, 2048)),
                    0
                );
                assert_eq!(f.bytes(2064, 1), &[4]);
                assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", fd), 0);
            }
        }
    }
}

#[test]
fn both_wait_imports_encode_startup_failure_as_eight_bytes_without_consuming_on_fault() {
    for by_job in [false, true] {
        for mut f in Fixture::both() {
            let request=serde_json::to_vec(&serde_json::json!({"executable":"/missing","argv":[],"env":{},"cwd":"/","job":0,"fds":[]})).unwrap();
            f.write(512, &request);
            let pid = f.call("runtime_proc", "spawn", (512, request.len() as i32));
            assert!(pid > 0);
            let job = f.call("runtime_proc", "job_of", pid);
            let subscription: Vec<u8> = [6u32, pid as u32, 123, 0]
                .into_iter()
                .flat_map(u32::to_le_bytes)
                .collect();
            f.write(256, &subscription);
            assert_eq!(f.call("runtime_proc", "poll", (256, 1, 5000, 80)), 1);
            assert_eq!(f.word(80), 123);
            assert_eq!(f.word(88), 6);
            assert_eq!(f.call("runtime_proc", "start_status", pid), 44);
            assert_eq!(f.call("runtime_proc", "start_status", pid), 44);
            if by_job {
                assert_eq!(
                    f.call("runtime_proc", "wait_job", (job, 1, 65532)),
                    process::FAULT
                );
                assert_eq!(f.call("runtime_proc", "wait_job", (job, 0, 80)), 0);
            } else {
                assert_eq!(f.call("runtime_proc", "wait", (pid, 65532)), process::FAULT);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                loop {
                    let result = f.call("runtime_proc", "wait", (pid, 80));
                    if result == 0 {
                        break;
                    }
                    assert_eq!(result, process::AGAIN);
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::yield_now();
                }
            }
            assert_eq!(f.word(80), 2);
            assert_eq!(f.word(84), 44);
            assert_eq!(f.call("runtime_proc", "start_status", pid), process::CHILD);
            assert_eq!(
                f.call("runtime_proc", "poll", (256, 1, 0, 80)),
                process::CHILD
            );
            assert_eq!(f.call("runtime_proc", "wait", (pid, 80)), process::CHILD);
            if by_job {
                assert_eq!(
                    f.call("runtime_proc", "wait_job", (job, 1, 80)),
                    process::CHILD
                );
            }
        }
    }
}

#[test]
fn fd_kind_tracks_pipes_files_remaps_and_closed_descriptors_without_consuming() {
    for mut f in Fixture::both() {
        assert_eq!(f.call("runtime_proc", "fd_kind", 3), 4);
        for fd in [-1, 400000, i32::MAX] {
            assert_eq!(f.call("runtime_proc", "fd_kind", fd), process::BADF);
        }
        let [read, write] = f.pipe();
        for fd in [read, write] {
            assert_eq!(f.call("runtime_proc", "fd_kind", fd), 1);
        }
        let duplicate = f.call("runtime_proc", "dup", read);
        assert_eq!(f.call("runtime_proc", "fd_kind", duplicate), 1);
        assert_eq!(f.call("runtime_proc", "write", (write, 256, 1)), 1);
        assert_eq!(f.call("runtime_proc", "fd_kind", read), 1);
        assert_eq!(f.call("runtime_proc", "read", (read, 512, 1)), 1);
        let file = f.open_manifest(3);
        assert_eq!(f.call("runtime_proc", "fd_kind", file), 3);
        f.iovec(2048, 8);
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_read", (file, 32, 1, 48)),
            0
        );
        assert_eq!(f.bytes(2048, 8), b"[package");
        assert_eq!(
            f.call("wasi_snapshot_preview1", "fd_renumber", (file, 0)),
            0
        );
        assert_eq!(f.call("runtime_proc", "fd_kind", 0), 3);
        assert_eq!(f.call("runtime_proc", "fd_kind", file), process::BADF);
        assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", read), 0);
        assert_eq!(f.call("runtime_proc", "fd_kind", read), process::BADF);
        assert_eq!(f.call("runtime_proc", "fd_kind", duplicate), 1);
    }
}

#[test]
fn cwd_reports_the_full_length_and_writes_only_when_it_fits() {
    for mut f in Fixture::both() {
        assert_eq!(f.call("runtime_proc", "cwd", (1024, 0)), 9);
        assert_eq!(f.call("runtime_proc", "cwd", (1024, 4)), 9);
        assert_eq!(f.bytes(1024, 4), &[0; 4]);
        assert_eq!(f.call("runtime_proc", "cwd", (1024, 64)), 9);
        assert_eq!(f.bytes(1024, 9), b"/work/app");
        assert_eq!(f.call("runtime_proc", "cwd", (65536, 0)), 9);
        assert_eq!(f.call("runtime_proc", "cwd", (65530, 9)), process::FAULT);
    }
}

/// Removes its scratch directory however the test ends.
struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Reads one `runtime_fs.watch_read` result into (type, name) pairs.
fn watch_records(f: &mut Fixture, id: i32) -> Result<Vec<(u8, Option<String>)>, i32> {
    let errno = f.call("runtime_fs", "watch_read", (id, 4096, 2048, 64));
    if errno != 0 {
        return Err(errno);
    }
    let mut bytes = f.bytes(4096, f.word(64) as usize).to_vec();
    let mut records = Vec::new();
    while !bytes.is_empty() {
        let length = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let (name, stride) = if length == u32::MAX {
            (None, 8)
        } else {
            let length = length as usize;
            (
                Some(String::from_utf8(bytes[8..8 + length].to_vec()).unwrap()),
                8 + length.next_multiple_of(4),
            )
        };
        records.push((bytes[0], name));
        bytes.drain(..stride);
    }
    Ok(records)
}

/// Sleep in the network poll until a drain of the watch reports `name` as a rename.
fn wait_for_rename(f: &mut Fixture, id: i32, name: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        assert!(std::time::Instant::now() < deadline, "no rename for {name}");
        f.store.data_mut().net.poll(1000);
        while let Ok(records) = watch_records(f, id) {
            if records
                .iter()
                .any(|record| *record == (2, Some(name.to_string())))
            {
                return;
            }
        }
    }
}

#[test]
fn runtime_fs_watches_follow_an_opened_directory_and_wake_the_network_poll() {
    let root =
        std::env::temp_dir().join(format!("bun-wasm-runtime-fs-watch-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("app")).unwrap();
    let _scratch = Scratch(root.clone());
    let mut f = Fixture::at(&root);
    // Rust's File::open through wasi-libc's open(O_RDONLY): symlink-follow lookup, no open
    // flags, every right except FD_DATASYNC, FD_WRITE, FD_ALLOCATE and FD_FILESTAT_SET_SIZE.
    f.write(1024, b"app");
    let rights = 0x1fff_ffffi64 & !(1 | 1 << 6 | 1 << 8 | 1 << 22);
    assert_eq!(
        f.call(
            "wasi_snapshot_preview1",
            "path_open",
            (3, 1, 1024, 3, 0, rights, rights, 0, 128)
        ),
        0
    );
    let directory = f.word(128);
    assert_eq!(
        f.call("runtime_fs", "watch_open", (directory, 2, 132)),
        28,
        "unknown flags"
    );
    assert_eq!(
        f.call("runtime_fs", "watch_open", (999, 0, 132)),
        8,
        "unknown descriptor"
    );
    let [reader, _writer] = f.pipe();
    assert_eq!(
        f.call("runtime_fs", "watch_open", (reader, 0, 132)),
        28,
        "a pipe is not a file"
    );
    assert_eq!(
        f.call("runtime_fs", "watch_open", (directory, 0, 65_534)),
        21,
        "output span"
    );
    assert_eq!(f.call("runtime_fs", "watch_open", (directory, 1, 132)), 0);
    let id = f.word(132);
    assert_eq!(watch_records(&mut f, id), Err(6), "nothing pending yet");
    std::fs::write(root.join("app/page.tsx"), "1").unwrap();
    wait_for_rename(&mut f, id, "page.tsx");
    // The watch follows the node, not the descriptor that registered it.
    assert_eq!(f.call("wasi_snapshot_preview1", "fd_close", directory), 0);
    std::fs::create_dir(root.join("app/routes")).unwrap();
    std::fs::write(root.join("app/routes/index.tsx"), "1").unwrap();
    wait_for_rename(&mut f, id, "routes/index.tsx");
    assert_eq!(f.call("runtime_fs", "watch_close", id), 0);
    assert_eq!(f.call("runtime_fs", "watch_close", id), 8);
    assert_eq!(watch_records(&mut f, id), Err(8));
}
