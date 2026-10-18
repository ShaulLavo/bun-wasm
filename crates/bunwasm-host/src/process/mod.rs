mod pipe;
mod stdin;
mod stdio;

pub use stdio::{Cancellation, FinalOutcome, Stdio};

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Waker};
use std::thread::JoinHandle;

use serde::Deserialize;
use wasmtime_wasi::cli::StdoutStream;

use crate::net::{AGAIN, BADF, ErrorInfo, Notify};
use pipe::Pipe;
use stdin::SharedInput;

pub const FIRST_HANDLE: i32 = 0x4000_0000;
/// Metadata selector on the existing child_pipe slot; fd 0..=2 remain pipes.
pub const CHILD_FINAL_SIGNAL: i32 = 3;
/// Worker control streams follow metadata rather than occupying selector 3.
pub const CHILD_WORKER_INPUT: i32 = 4;
pub const CHILD_WORKER_OUTPUT: i32 = 5;
const MAX_CHILDREN: usize = 4;
const BUN_EXECUTABLE_ALIASES: [&str; 6] = [
    "bun",
    "/bun",
    "node",
    "/node",
    "/usr/local/bin/bun",
    "/usr/local/bin/node",
];

pub struct Runtime {
    pub engine: wasmtime::Engine,
    pub module: wasmtime::Module,
    pub tools_path: Option<std::path::PathBuf>,
    tools: std::sync::OnceLock<Result<wasmtime::Module, String>>,
    pub dirs: Vec<(std::path::PathBuf, String)>,
    active: AtomicUsize,
}

impl Runtime {
    pub fn new(
        engine: wasmtime::Engine,
        module: wasmtime::Module,
        dirs: Vec<(std::path::PathBuf, String)>,
    ) -> Arc<Self> {
        Arc::new(Self {
            engine,
            module,
            dirs,
            tools_path: None,
            tools: std::sync::OnceLock::new(),
            active: AtomicUsize::new(0),
        })
    }
    pub fn module_for(&self, argv: &[String]) -> anyhow::Result<&wasmtime::Module> {
        if crate::tool_args::before_command(argv.get(1..).unwrap_or_default()).is_none() {
            return Ok(&self.module);
        }
        let tools = self.tools.get_or_init(|| {
            let path = self
                .tools_path
                .as_ref()
                .ok_or("tools artifact path is unavailable")?;
            wasmtime::Module::from_file(&self.engine, path)
                .map_err(|error| format!("loading {}: {error}", path.display()))
        });
        tools
            .as_ref()
            .map_err(|message| anyhow::anyhow!("{message}"))
    }
}

#[derive(Deserialize)]
pub struct Request {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    stdin: String,
    stdout: String,
    stderr: String,
    #[serde(default)]
    worker: Option<WorkerLimits>,
    #[serde(default)]
    purpose: Option<ChildPurpose>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChildPurpose {
    Configuration,
}

enum Admission {
    Public(Arc<Runtime>),
    Configuration(Arc<AtomicBool>),
}

impl Drop for Admission {
    fn drop(&mut self) {
        match self {
            Self::Public(runtime) => {
                runtime.active.fetch_sub(1, Ordering::SeqCst);
            }
            Self::Configuration(active) => {
                active.store(false, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerLimits {
    pub memory_limit_mb: Option<usize>,
}

struct Child {
    cancel: Arc<Cancellation>,
    result: Arc<Mutex<Option<FinalOutcome>>>,
    reaped: AtomicBool,
    thread: Option<JoinHandle<()>>,
    pipes: [i32; 5],
}

struct PipeHandle {
    pipe: Pipe,
    write: bool,
}

pub struct Processes {
    runtime: Arc<Runtime>,
    stdio: Stdio,
    stdin: SharedInput,
    notify: Arc<Notify>,
    next: u32,
    children: HashMap<i32, Child>,
    pipes: HashMap<i32, PipeHandle>,
    worker_pipes: [i32; 2],
    configuration_active: Arc<AtomicBool>,
}

fn error(message: impl Into<String>, code: &str) -> ErrorInfo {
    ErrorInfo::new("Error", message, Some(code))
}

fn close_child_pipes(inputs: Vec<Pipe>, outputs: Vec<Pipe>) {
    for pipe in inputs {
        pipe.close_reader();
    }
    for pipe in outputs {
        pipe.close_writer();
    }
}

impl Processes {
    pub fn new(runtime: Arc<Runtime>, stdio: Stdio, notify: Arc<Notify>) -> Self {
        let worker = stdio.worker.clone();
        let mut processes = Self {
            runtime,
            stdin: stdio.stdin.clone(),
            stdio,
            notify,
            next: FIRST_HANDLE as u32,
            children: HashMap::new(),
            pipes: HashMap::new(),
            worker_pipes: [0; 2],
            configuration_active: Arc::new(AtomicBool::new(false)),
        };
        if let Some(pipes) = worker {
            for (index, pipe) in pipes.into_iter().enumerate() {
                pipe.observe(&processes.notify);
                let id = processes
                    .next()
                    .expect("fresh worker has room for both inherited pipes");
                processes.pipes.insert(
                    id,
                    PipeHandle {
                        pipe,
                        write: index == 1,
                    },
                );
                processes.worker_pipes[index] = id;
            }
        }
        processes
    }

    fn require_handles(&self, count: usize) -> Result<(), ErrorInfo> {
        // u32 can retain the exhausted sentinel after allocating i32::MAX.
        let available = (i32::MAX as u32 + 1).saturating_sub(self.next) as usize;
        if count > available {
            return Err(error("bun-wasm child handle space exhausted", "EAGAIN"));
        }
        Ok(())
    }

    fn next(&mut self) -> Result<i32, ErrorInfo> {
        self.require_handles(1)?;
        let id = self.next as i32;
        self.next += 1;
        Ok(id)
    }

    fn pipe(&mut self, write: bool) -> Result<(i32, Pipe), ErrorInfo> {
        let id = self.next()?;
        let pipe = Pipe::new(self.notify.clone());
        self.pipes.insert(
            id,
            PipeHandle {
                pipe: pipe.clone(),
                write,
            },
        );
        Ok((id, pipe))
    }

    fn stdin(&mut self, mode: &str) -> Result<(i32, SharedInput), ErrorInfo> {
        match mode {
            "inherit" => Ok((0, self.stdio.stdin.clone())),
            "ignore" => Ok((
                0,
                SharedInput::new(Arc::new(wasmtime_wasi::p2::pipe::MemoryInputPipe::new(
                    Vec::new(),
                ))),
            )),
            "pipe" => {
                let (id, pipe) = self.pipe(true)?;
                Ok((id, SharedInput::new(Arc::new(pipe))))
            }
            _ => Err(error("Unsupported stdin mode in bun-wasm", "EINVAL")),
        }
    }

    fn output(
        &mut self,
        mode: &str,
        fd: usize,
    ) -> Result<(i32, Arc<dyn StdoutStream + Sync>), ErrorInfo> {
        match mode {
            "inherit" => Ok((
                0,
                if fd == 1 {
                    self.stdio.stdout.clone()
                } else {
                    self.stdio.stderr.clone()
                },
            )),
            "ignore" => Ok((0, Arc::new(tokio::io::empty()))),
            "pipe" => {
                let (id, pipe) = self.pipe(false)?;
                Ok((id, Arc::new(pipe)))
            }
            _ => Err(error("Unsupported output mode in bun-wasm", "EINVAL")),
        }
    }

    pub fn spawn(&mut self, meta: &[u8]) -> Result<i32, ErrorInfo> {
        let request: Request =
            serde_json::from_slice(meta).map_err(|e| error(e.to_string(), "EINVAL"))?;
        let command = request.argv.first().map(String::as_str).unwrap_or("");
        if !BUN_EXECUTABLE_ALIASES.contains(&command) {
            return Err(error(
                format!("spawn {command} ENOENT: only bun is supported in bun-wasm"),
                "ENOENT",
            ));
        }
        let cwd = std::path::Path::new(&request.cwd);
        if !cwd.is_absolute()
            || cwd
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(error(
                "Child cwd must be an absolute normalized guest path",
                "EINVAL",
            ));
        }
        let mapped = self
            .runtime
            .dirs
            .iter()
            .filter_map(|(host, guest)| {
                cwd.strip_prefix(guest)
                    .ok()
                    .map(|rest| (guest.len(), host.join(rest)))
            })
            .max_by_key(|(length, _)| *length)
            .map(|(_, path)| path);
        if !mapped.is_some_and(|p| p.is_dir()) {
            return Err(error(format!("spawn cwd {} ENOENT", request.cwd), "ENOENT"));
        }
        for mode in [&request.stdin, &request.stdout, &request.stderr] {
            if !matches!(mode.as_str(), "pipe" | "inherit" | "ignore") {
                return Err(error("Unsupported stdio mode in bun-wasm", "EINVAL"));
            }
        }
        let admission = self.admit(&request)?;
        self.start(request, admission)
    }

    fn admit(&self, request: &Request) -> Result<Admission, ErrorInfo> {
        if request.purpose.is_some() {
            if self.stdio.configuration {
                return Err(error(
                    "Configuration helpers cannot start another internal evaluation",
                    "EPERM",
                ));
            }
            if request.argv[0] != "bun"
                || request.worker.is_some()
                || request.argv.len() != 4
                || request.argv[1..3] != ["--no-install", "-e"]
                || request.stdin != "ignore"
                || request.stdout != "pipe"
                || request.stderr != "pipe"
            {
                return Err(error("Invalid configuration helper command", "EINVAL"));
            }
            self.configuration_active
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .map_err(|_| {
                    error(
                        "This process already has a configuration evaluation",
                        "EAGAIN",
                    )
                })?;
            return Ok(Admission::Configuration(self.configuration_active.clone()));
        }
        self.runtime
            .active
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_CHILDREN).then_some(n + 1)
            })
            .map_err(|_| {
                error(
                    "bun-wasm child concurrency limit reached (4 active children)",
                    "EAGAIN",
                )
            })?;
        Ok(Admission::Public(self.runtime.clone()))
    }

    fn start(&mut self, mut request: Request, admission: Admission) -> Result<i32, ErrorInfo> {
        let stdio_pipes = [&request.stdin, &request.stdout, &request.stderr]
            .into_iter()
            .filter(|mode| mode.as_str() == "pipe")
            .count();
        // Reserve capacity before creating any pipe or starting a child thread.
        self.require_handles(1 + stdio_pipes + if request.worker.is_some() { 2 } else { 0 })?;
        request.env.insert("PWD".into(), request.cwd.clone());
        let (stdin_id, stdin) = self.stdin(&request.stdin)?;
        let (stdout_id, stdout) = self.output(&request.stdout, 1)?;
        let (stderr_id, stderr) = self.output(&request.stderr, 2)?;
        let (to_worker, from_worker, worker) = if request.worker.is_some() {
            let (incoming, input) = self.pipe(true)?;
            let (outgoing, output) = self.pipe(false)?;
            (incoming, outgoing, Some([input, output]))
        } else {
            (0, 0, None)
        };
        let memory_limit = request
            .worker
            .as_ref()
            .and_then(|limits| limits.memory_limit_mb)
            .map(|mb| mb.saturating_mul(1 << 20))
            .unwrap_or(512 << 20);
        let pipes = [stdin_id, stdout_id, stderr_id, to_worker, from_worker];
        let inputs: Vec<Pipe> = [stdin_id, to_worker]
            .into_iter()
            .filter_map(|id| self.pipes.get(&id).map(|p| p.pipe.clone()))
            .collect();
        let outputs: Vec<Pipe> = [stdout_id, stderr_id, from_worker]
            .into_iter()
            .filter_map(|id| self.pipes.get(&id).map(|p| p.pipe.clone()))
            .collect();
        let result = Arc::new(Mutex::new(None));
        let cancel = Arc::new(Cancellation::default());
        let (runtime, notify, completed, cancellation) = (
            self.runtime.clone(),
            self.notify.clone(),
            result.clone(),
            cancel.clone(),
        );
        let id = self.next()?;
        let thread = std::thread::Builder::new()
            .name("bun-wasm-child".into())
            .stack_size(crate::THREAD_STACK)
            .spawn(move || {
                let outcome = crate::run_instance(
                    runtime.clone(),
                    request.argv,
                    request.env.into_iter().collect(),
                    Stdio {
                        stdin,
                        stdout,
                        stderr,
                        worker,
                        memory_limit,
                        configuration: request.purpose.is_some(),
                    },
                    cancellation.clone(),
                )
                .unwrap_or_else(|e| {
                    eprintln!("bun-wasm child: {e:#}");
                    cancellation.select(FinalOutcome::Exit(1))
                });
                // Child stdin and worker control input are readers; only its
                // stdout, stderr and worker control output are writer endpoints.
                close_child_pipes(inputs, outputs);
                drop(admission);
                *completed.lock().unwrap() = Some(outcome);
                notify.bump();
            });
        let thread = match thread {
            Ok(thread) => thread,
            Err(cause) => {
                self.close_pipes(pipes);
                return Err(error(cause.to_string(), "EAGAIN"));
            }
        };
        self.children.insert(
            id,
            Child {
                cancel,
                result,
                reaped: AtomicBool::new(false),
                thread: Some(thread),
                pipes,
            },
        );
        Ok(id)
    }

    fn close_pipes(&mut self, pipes: [i32; 5]) {
        for id in pipes {
            if id != 0 {
                self.close(id);
            }
        }
    }

    pub fn wait(&mut self, id: i32) -> i32 {
        let Some(child) = self.children.get_mut(&id) else {
            return BADF;
        };
        let Some(outcome) = *child.result.lock().unwrap() else {
            return AGAIN;
        };
        if let Some(thread) = child.thread.take() {
            let _ = thread.join();
        }
        child.reaped.store(true, Ordering::SeqCst);
        outcome.code()
    }

    pub fn child_pipe(&self, id: i32, selector: i32) -> i32 {
        if id == 0 {
            return match selector {
                CHILD_WORKER_INPUT => self.worker_pipes[0],
                CHILD_WORKER_OUTPUT => self.worker_pipes[1],
                _ => BADF,
            };
        }
        let Some(child) = self.children.get(&id) else {
            return BADF;
        };
        if selector == CHILD_FINAL_SIGNAL {
            let Some(outcome) = *child.result.lock().unwrap() else {
                return AGAIN;
            };
            child.reaped.store(true, Ordering::SeqCst);
            return outcome.signal();
        }
        let index = match selector {
            0..=2 => selector,
            CHILD_WORKER_INPUT | CHILD_WORKER_OUTPUT => selector - 1,
            _ => return BADF,
        };
        child.pipes[index as usize]
    }

    pub fn kill(&mut self, id: i32, signal: i32) -> i32 {
        if !(0..=64).contains(&signal) {
            return -1;
        }
        let Some(child) = self.children.get(&id) else {
            return BADF;
        };
        if child.reaped.load(Ordering::SeqCst) {
            return BADF;
        }
        // A selected child is a zombie until its final result is consumed.
        // A late request succeeds without changing that immutable winner.
        child.cancel.kill(signal);
        self.notify.bump();
        0
    }

    pub fn error(&self, id: i32) -> crate::net::Output {
        let info = if let Some(pipe) = self.pipes.get(&id) {
            let info = error("Child process pipe is closed", "EPIPE");
            if pipe.write {
                info.with_errno(-32).with_syscall("write")
            } else {
                info
            }
        } else if self.children.contains_key(&id) {
            error("Child process is no longer running", "ESRCH")
        } else {
            error("Unknown child process handle", "EBADF")
        };
        crate::net::Output::Bytes(info.to_json())
    }

    pub fn read(&mut self, id: i32, buf: &mut [u8]) -> i32 {
        if id == 0 {
            if buf.is_empty() {
                return 0;
            }
            let waker = Waker::from(self.notify.clone());
            let mut context = Context::from_waker(&waker);
            if self.stdin.poll_ready(&mut context).is_pending() {
                return AGAIN;
            }
            return match self.stdin.read(buf.len()) {
                Ok(bytes) => {
                    buf[..bytes.len()].copy_from_slice(&bytes);
                    bytes.len() as i32
                }
                Err(wasmtime_wasi::p2::StreamError::Closed) => 0,
                Err(_) => -1,
            };
        }
        match self.pipes.get(&id) {
            Some(p) if !p.write => p.pipe.read(buf),
            _ => BADF,
        }
    }
    pub fn write(&self, id: i32, bytes: &[u8]) -> i32 {
        match self.pipes.get(&id) {
            Some(p) if p.write => p.pipe.write(bytes),
            _ => BADF,
        }
    }
    pub fn close(&mut self, id: i32) -> i32 {
        if let Some(pipe) = self.pipes.remove(&id) {
            if pipe.write {
                pipe.pipe.close_writer();
            } else {
                pipe.pipe.close_reader();
            }
            return 0;
        }
        let Some(mut child) = self.children.remove(&id) else {
            return BADF;
        };
        child.cancel.kill(9);
        if let Some(thread) = child.thread.take() {
            let _ = thread.join();
        }
        0
    }
}

impl Drop for Processes {
    fn drop(&mut self) {
        for child in self.children.values() {
            child.cancel.kill(9);
        }
        for (_, mut child) in self.children.drain() {
            if let Some(thread) = child.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn processes() -> Processes {
        let mut config = wasmtime::Config::new();
        config.epoch_interruption(true);
        let engine = wasmtime::Engine::new(&config).unwrap();
        // Original no-op guest: (module (func (export "_start"))).
        let module = wasmtime::Module::new(
            &engine,
            b"\0asm\x01\0\0\0\x01\x04\x01\x60\0\0\x03\x02\x01\0\x07\x0a\x01\x06_start\0\0\x0a\x04\x01\x02\0\x0b",
        )
        .unwrap();
        let runtime = Runtime::new(
            engine,
            module,
            vec![(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")),
                "/".into(),
            )],
        );
        Processes::new(runtime, Stdio::inherited(), crate::net::Net::new().notify())
    }

    fn request(argv: &[&str]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "argv": argv,
            "cwd": "/",
            "env": {},
            "stdin": "ignore",
            "stdout": "ignore",
            "stderr": "ignore",
        }))
        .unwrap()
    }

    fn assert_spawn_succeeds(processes: &mut Processes, command: &str) {
        let child = processes
            .spawn(&request(&[command, "child.js"]))
            .unwrap_or_else(|error| panic!("{command}: {error:?}"));
        processes
            .children
            .get_mut(&child)
            .unwrap()
            .thread
            .take()
            .unwrap()
            .join()
            .unwrap();
        assert_eq!(processes.wait(child), 0, "{command}");
        assert_eq!(processes.close(child), 0, "{command}");
        assert_eq!(processes.runtime.active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn final_signal_selector_waits_for_publication_and_preserves_pipe_selectors() {
        let mut processes = processes();
        let (stdin_id, input) = processes.pipe(true).unwrap();
        let (stdout_id, output) = processes.pipe(false).unwrap();
        let pipes = [stdin_id, stdout_id, 0, 0, 0];
        let cancel = Arc::new(Cancellation::default());
        let result = Arc::new(Mutex::new(None));
        let id = processes.next().unwrap();
        processes.children.insert(
            id,
            Child {
                cancel: cancel.clone(),
                result: result.clone(),
                reaped: AtomicBool::new(false),
                thread: None,
                pipes,
            },
        );
        for (fd, pipe) in pipes[..3].iter().enumerate() {
            assert_eq!(processes.child_pipe(id, fd as i32), *pipe);
        }
        assert_eq!(processes.child_pipe(id, CHILD_WORKER_INPUT), 0);
        assert_eq!(processes.child_pipe(id, CHILD_WORKER_OUTPUT), 0);
        assert_eq!(processes.child_pipe(id, -1), BADF);
        assert_eq!(processes.child_pipe(id, 6), BADF);
        assert_eq!(processes.child_pipe(id + 1, CHILD_FINAL_SIGNAL), BADF);
        assert_eq!(processes.kill(id + 1, 15), BADF);
        assert_eq!(processes.wait(id), AGAIN);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), AGAIN);

        assert_eq!(cancel.signal(15, 2), 0);
        assert!(cancel.kill(15));
        let outcome = cancel.select(FinalOutcome::Exit(143));
        for signal in [15, 9] {
            assert_eq!(processes.kill(id, signal), 0);
            for _ in 0..3 {
                assert_eq!(processes.wait(id), AGAIN);
                assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), AGAIN);
            }
            assert_eq!(cancel.select(FinalOutcome::Signal(signal)), outcome);
        }
        input.close_reader();
        output.close_writer();
        *result.lock().unwrap() = Some(outcome);
        assert_eq!(processes.kill(id, 15), 0);
        assert_eq!(processes.kill(id, 9), 0);
        assert_eq!(cancel.select(FinalOutcome::Signal(9)), outcome);
        assert_eq!(processes.write(stdin_id, b"late"), -1);
        assert_eq!(processes.read(stdout_id, &mut [0]), 0);
        assert_eq!(processes.wait(id), 143);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), 0);
        assert_eq!(processes.kill(id, 15), BADF);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), 0);
        assert_eq!(processes.close(id), 0);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), BADF);
    }

    #[test]
    fn final_signal_selector_reports_observed_term_not_numeric_exit_status() {
        let mut processes = processes();
        let cancel = Arc::new(Cancellation::default());
        let result = Arc::new(Mutex::new(None));
        let id = processes.next().unwrap();
        processes.children.insert(
            id,
            Child {
                cancel: cancel.clone(),
                result: result.clone(),
                reaped: AtomicBool::new(false),
                thread: None,
                pipes: [0; 5],
            },
        );
        assert_eq!(processes.kill(id, 15), 0);
        assert!(cancel.check().is_err());
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), AGAIN);
        *result.lock().unwrap() = Some(cancel.select(FinalOutcome::Exit(1)));
        assert_eq!(processes.kill(id, 9), 0);
        // Reading published final metadata also reaps, without changing the result.
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), 15);
        assert_eq!(processes.kill(id, 9), BADF);
        assert_eq!(processes.wait(id), 143);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), 15);
    }

    #[test]
    fn worker_stream_selectors_preserve_each_endpoint_direction() {
        let parent = processes();
        let input = Pipe::new(parent.notify.clone());
        let output = Pipe::new(parent.notify.clone());
        let mut stdio = Stdio::inherited();
        stdio.worker = Some([input.clone(), output.clone()]);
        let mut worker = Processes::new(
            parent.runtime.clone(),
            stdio,
            crate::net::Net::new().notify(),
        );
        let read = worker.child_pipe(0, CHILD_WORKER_INPUT);
        let write = worker.child_pipe(0, CHILD_WORKER_OUTPUT);
        assert!(read >= FIRST_HANDLE);
        assert!(write > read);
        assert_eq!(worker.child_pipe(0, CHILD_FINAL_SIGNAL), BADF);
        assert_eq!(worker.child_pipe(0, 6), BADF);
        assert_eq!(input.write(b"in"), 2);
        let mut bytes = [0; 2];
        assert_eq!(worker.read(read, &mut bytes), 2);
        assert_eq!(&bytes, b"in");
        assert_eq!(worker.write(read, b"wrong end"), BADF);
        assert_eq!(worker.write(write, b"ok"), 2);
        assert_eq!(worker.read(write, &mut bytes), BADF);
        assert_eq!(output.read(&mut bytes), 2);
        assert_eq!(&bytes, b"ok");
    }

    #[test]
    fn worker_endpoints_close_before_signaled_completion_is_published() {
        let mut processes = processes();
        let (stdin_id, stdin) = processes.pipe(true).unwrap();
        let (stdout_id, stdout) = processes.pipe(false).unwrap();
        let (stderr_id, stderr) = processes.pipe(false).unwrap();
        let (worker_input_id, worker_input) = processes.pipe(true).unwrap();
        let (worker_output_id, worker_output) = processes.pipe(false).unwrap();
        let cancel = Arc::new(Cancellation::default());
        let result = Arc::new(Mutex::new(None));
        let id = processes.next().unwrap();
        processes.children.insert(
            id,
            Child {
                cancel: cancel.clone(),
                result: result.clone(),
                reaped: AtomicBool::new(false),
                thread: None,
                pipes: [
                    stdin_id,
                    stdout_id,
                    stderr_id,
                    worker_input_id,
                    worker_output_id,
                ],
            },
        );
        assert_eq!(
            processes.child_pipe(id, CHILD_WORKER_INPUT),
            worker_input_id
        );
        assert_eq!(
            processes.child_pipe(id, CHILD_WORKER_OUTPUT),
            worker_output_id
        );
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), AGAIN);
        assert_eq!(processes.write(stdin_id, b"pending stdin"), 13);
        assert_eq!(processes.write(worker_input_id, b"pending control"), 15);
        assert_eq!(stdout.write(b"out"), 3);
        assert_eq!(stderr.write(b"err"), 3);
        assert_eq!(worker_output.write(b"message"), 7);
        assert_eq!(processes.kill(id, 2), 0);
        let outcome = cancel.select(FinalOutcome::Exit(0));
        assert_eq!(outcome, FinalOutcome::Signal(2));
        let input_probe = worker_input.clone();
        close_child_pipes(
            vec![stdin, worker_input],
            vec![stdout, stderr, worker_output],
        );
        // Teardown is observable before final metadata or wait status. Input
        // readers discard unread bytes and reject writes; output still drains.
        assert_eq!(processes.wait(id), AGAIN);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), AGAIN);
        assert_eq!(processes.write(stdin_id, b"late"), -1);
        assert_eq!(processes.write(worker_input_id, b"late"), -1);
        // Closing its writer instead would leave the queued control bytes here.
        assert_eq!(input_probe.read(&mut [0; 15]), AGAIN);
        let mut bytes = [0; 7];
        for (pipe, expected) in [
            (stdout_id, &b"out"[..]),
            (stderr_id, &b"err"[..]),
            (worker_output_id, &b"message"[..]),
        ] {
            assert_eq!(processes.read(pipe, &mut bytes), expected.len() as i32);
            assert_eq!(&bytes[..expected.len()], expected);
            assert_eq!(processes.read(pipe, &mut bytes), 0);
        }
        assert_eq!(processes.kill(id, 9), 0);
        assert_eq!(cancel.select(FinalOutcome::Signal(9)), outcome);
        *result.lock().unwrap() = Some(outcome);
        assert_eq!(processes.child_pipe(id, CHILD_FINAL_SIGNAL), 2);
        assert_eq!(processes.wait(id), 130);
        assert_eq!(processes.kill(id, 9), BADF);
        assert_eq!(
            processes.child_pipe(id, CHILD_WORKER_INPUT),
            worker_input_id
        );
        assert_eq!(
            processes.child_pipe(id, CHILD_WORKER_OUTPUT),
            worker_output_id
        );
    }

    #[test]
    fn handle_allocator_stops_after_the_last_positive_handle() {
        let mut processes = processes();
        processes.next = i32::MAX as u32 - 1;
        assert_eq!(processes.next().unwrap(), i32::MAX - 1);
        assert_eq!(processes.next().unwrap(), i32::MAX);
        assert_eq!(processes.next, i32::MAX as u32 + 1);
        for _ in 0..3 {
            let error = processes.next().unwrap_err();
            assert_eq!(error.code.as_deref(), Some("EAGAIN"));
            assert_eq!(processes.next, i32::MAX as u32 + 1);
        }
    }

    #[test]
    fn pipe_exhaustion_does_not_insert_a_negative_or_reused_handle() {
        let mut processes = processes();
        processes.next = i32::MAX as u32;
        let (id, _) = processes.pipe(true).unwrap();
        assert_eq!(id, i32::MAX);
        assert_eq!(processes.pipes.len(), 1);
        let error = match processes.pipe(false) {
            Err(error) => error,
            Ok(_) => panic!("exhausted allocator created another pipe"),
        };
        assert_eq!(error.code.as_deref(), Some("EAGAIN"));
        assert_eq!(processes.pipes.len(), 1);
        assert!(processes.pipes.contains_key(&i32::MAX));
        assert_eq!(processes.close(id), 0);
        assert!(processes.pipes.is_empty());
        assert!(processes.next().is_err());
    }

    #[test]
    fn spawn_exhaustion_preflights_stdio_and_worker_handles_without_partial_resources() {
        for worker in [false, true] {
            let mut processes = processes();
            let required = if worker { 6 } else { 4 };
            processes.next = i32::MAX as u32 - (required - 2);
            let next = processes.next;
            let meta = serde_json::to_vec(&serde_json::json!({
                "argv": ["bun", "child.js"], "cwd": "/", "env": {},
                "stdin": "pipe", "stdout": "pipe", "stderr": "pipe",
                "worker": if worker { serde_json::json!({}) } else { serde_json::Value::Null },
            }))
            .unwrap();
            for _ in 0..3 {
                let error = processes.spawn(&meta).unwrap_err();
                assert_eq!(error.code.as_deref(), Some("EAGAIN"));
                assert_eq!(processes.next, next);
                assert!(processes.pipes.is_empty());
                assert!(processes.children.is_empty());
                assert_eq!(processes.runtime.active.load(Ordering::SeqCst), 0);
            }
        }
    }

    #[test]
    fn last_child_handle_preserves_completion_and_then_reports_exhaustion() {
        let mut processes = processes();
        processes.next = i32::MAX as u32;
        assert_spawn_succeeds(&mut processes, "bun");
        assert_eq!(processes.next, i32::MAX as u32 + 1);
        let error = processes.spawn(&request(&["bun", "child.js"])).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("EAGAIN"));
        assert!(processes.children.is_empty());
        assert!(processes.pipes.is_empty());
        assert_eq!(processes.runtime.active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn spawn_accepts_registered_bun_and_node_aliases() {
        let mut processes = processes();
        for command in [
            "bun",
            "/bun",
            "node",
            "/node",
            "/usr/local/bin/bun",
            "/usr/local/bin/node",
        ] {
            assert_spawn_succeeds(&mut processes, command);
        }
    }

    #[test]
    fn spawn_accepts_default_fork_exec_path() {
        let mut processes = processes();
        assert_spawn_succeeds(&mut processes, "/usr/local/bin/bun");
    }

    #[test]
    fn spawn_rejects_unregistered_commands() {
        let mut processes = processes();
        for command in [
            "",
            "sh",
            "bunx",
            "nodejs",
            "./bun",
            "/tmp/bun",
            "/tmp/node",
            "/usr/bin/bun",
            "/usr/bin/node",
            "/usr/local/bin/bun-other",
            "/usr/local/bin/node/child",
        ] {
            let error = processes.spawn(&request(&[command])).unwrap_err();
            assert_eq!(error.code.as_deref(), Some("ENOENT"), "{command}");
        }
        let error = processes.spawn(&request(&[])).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("ENOENT"));
        assert!(processes.children.is_empty());
        assert!(processes.pipes.is_empty());
        assert_eq!(processes.runtime.active.load(Ordering::SeqCst), 0);
    }
}

#[cfg(test)]
mod configuration_tests {
    use super::*;

    fn request() -> Request {
        serde_json::from_value(serde_json::json!({
            "purpose": "configuration", "argv": ["bun", "--no-install", "-e", "0"],
            "cwd": "/", "env": {}, "stdin": "ignore", "stdout": "pipe", "stderr": "pipe"
        }))
        .unwrap()
    }

    #[test]
    fn helpers_reserve_one_per_owner_without_using_public_capacity() {
        let root = super::tests::processes();
        root.runtime.active.store(MAX_CHILDREN, Ordering::SeqCst);
        let lease = root
            .admit(&request())
            .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(root.runtime.active.load(Ordering::SeqCst), MAX_CHILDREN);
        assert_eq!(
            root.admit(&request()).err().unwrap().code.as_deref(),
            Some("EAGAIN")
        );
        let mut stdio = Stdio::inherited();
        stdio.configuration = true;
        let helper = Processes::new(root.runtime.clone(), stdio, crate::net::Net::new().notify());
        assert_eq!(
            helper.admit(&request()).err().unwrap().code.as_deref(),
            Some("EPERM")
        );
        drop(lease);
        assert!(!root.configuration_active.load(Ordering::SeqCst));
        root.runtime.active.store(0, Ordering::SeqCst);
    }

    #[test]
    fn sequential_helpers_are_reaped_with_no_pipe_or_capacity_leak() {
        let mut root = super::tests::processes();
        root.runtime.active.store(MAX_CHILDREN, Ordering::SeqCst);
        for _ in 0..8 {
            let child = root
                .spawn(
                    &serde_json::to_vec(&serde_json::json!({
                        "purpose": "configuration", "argv": ["bun", "--no-install", "-e", "0"],
                        "cwd": "/", "env": {}, "stdin": "ignore", "stdout": "pipe", "stderr": "pipe"
                    }))
                    .unwrap(),
                )
                .unwrap();
            let pipes = root.children[&child].pipes;
            while root.wait(child) == AGAIN {
                std::thread::yield_now();
            }
            for pipe in pipes {
                if pipe != 0 {
                    root.close(pipe);
                }
            }
            root.close(child);
            assert!(!root.configuration_active.load(Ordering::SeqCst));
            assert_eq!(root.runtime.active.load(Ordering::SeqCst), MAX_CHILDREN);
            assert!(root.children.is_empty());
            assert!(root.pipes.is_empty());
        }
        root.runtime.active.store(0, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tools_tests {
    use super::*;

    #[test]
    fn ordinary_commands_never_load_tools() {
        let engine = wasmtime::Engine::default();
        let module = wasmtime::Module::new(&engine, b"\0asm\x01\0\0\0").unwrap();
        let runtime = Runtime::new(engine, module, Vec::new());
        for args in [
            vec!["bun", "run", "lint"],
            vec!["bun", "-e", "fmt"],
            vec!["bun", "build", "lint"],
        ] {
            let args = args.into_iter().map(String::from).collect::<Vec<_>>();
            assert!(runtime.module_for(&args).is_ok());
            assert!(runtime.tools.get().is_none());
        }
        let args = ["bun", "--cwd", "project", "lint"]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        assert!(runtime.module_for(&args).is_err());
        assert!(runtime.tools.get().is_some());
    }
}
