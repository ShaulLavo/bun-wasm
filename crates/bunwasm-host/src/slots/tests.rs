use super::*;
use crate::process::{self, Cancellation, FinalOutcome, Runtime, Stdio};
use std::sync::Arc;
use wasmtime::{Config, Engine, Memory, MemoryType, Module, StoreLimitsBuilder, WasmParams};

struct Fixture {
    store: Store<Host>,
    linker: Linker<Host>,
    runtime: Arc<Runtime>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.runtime.shutdown();
    }
}
impl Fixture {
    fn new() -> Self {
        let mut config = Config::new();
        config.epoch_interruption(true);
        let engine = Engine::new(&config).unwrap();
        let module = Module::new(&engine,b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0a\x01\x06_start\0\0\x0a\x04\x01\x02\0\x0b").unwrap();
        let runtime = Runtime::new(
            engine.clone(),
            module,
            vec![(env!("CARGO_MANIFEST_DIR").into(), "/".into())],
        );
        let net = crate::net::Net::new();
        let cancel = Arc::new(Cancellation::default());
        let stdio = Stdio::inherited();
        let mut wasi = wasmtime_wasi::WasiCtxBuilder::new();
        stdio.install(&mut wasi, cancel.clone());
        let processes =
            process::Processes::new(runtime.clone(), stdio, net.notify(), cancel.clone());
        let mut store = Store::new(
            &engine,
            Host {
                wasi: wasi.build_p1(),
                net,
                memory: None,
                trace: false,
                processes,
                limits: StoreLimitsBuilder::new().build(),
                functions: Vec::new(),
                cancel,
            },
        );
        store.set_epoch_deadline(1);
        let memory = Memory::new(&mut store, MemoryType::new(1, None)).unwrap();
        store.data_mut().memory = Some(memory);
        let mut linker = Linker::new(&engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |host: &mut Host| &mut host.wasi)
            .unwrap();
        add_import(&mut linker, &mut store).unwrap();
        Self {
            store,
            linker,
            runtime,
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

    fn write(&mut self, ptr: usize, bytes: &[u8]) {
        self.store
            .data()
            .memory
            .unwrap()
            .write(&mut self.store, ptr, bytes)
            .unwrap();
    }
    fn bytes(&self, ptr: usize, len: usize) -> &[u8] {
        &self.store.data().memory.unwrap().data(&self.store)[ptr..ptr + len]
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
    assert_eq!(SLOT_NAMES.len(), 14);
    assert_eq!(&SLOT_NAMES[12..], &["shutdown", "local_addr"]);
}

#[test]
fn runtime_pipe_and_preview1_io_close_and_renumber_share_descriptors() {
    let mut f = Fixture::new();
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

#[test]
fn stdio_binding_can_be_read_through_both_abis_without_buffer_loss() {
    let mut f = Fixture::new();
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

#[test]
fn process_import_faults_return_errno_before_resource_changes_or_job_reap() {
    let mut f = Fixture::new();
    assert_eq!(f.call("runtime_proc", "pipe", 65535), process::FAULT);
    let [read, write] = f.pipe();
    assert_eq!(read, process::FIRST_HANDLE);
    assert_eq!(write, read + 1);
    assert_eq!(
        f.call("runtime_proc", "poll", (0, -1, 0, 64)),
        process::FAULT
    );
    let request = serde_json::to_vec(
        &serde_json::json!({"executable":"absent","argv":[],"env":{},"cwd":"/","job":0,"fds":[]}),
    )
    .unwrap();
    f.write(512, &request);
    let pid = f.call("runtime_proc", "spawn", (512, request.len() as i32));
    assert!(pid > 0);
    let job = f.call("runtime_proc", "job_of", pid);
    assert_eq!(
        f.call("runtime_proc", "wait_job", (job, 1, 65535)),
        process::FAULT
    );
    assert_eq!(f.call("runtime_proc", "wait_job", (job, 0, 80)), 0);
    assert_eq!(f.word(80), 127);
    assert_eq!(f.call("runtime_proc", "wait", (pid, 88)), process::CHILD);
    assert_eq!(
        f.call("runtime_proc", "wait_job", (job, 1, 80)),
        process::CHILD
    );
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
