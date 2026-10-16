mod pipe;
mod stdio;
mod stdin;

pub use stdio::{Cancellation, Stdio};

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::task::{Context, Waker};

use serde::Deserialize;
use wasmtime_wasi::cli::StdoutStream;

use crate::net::{AGAIN, BADF, ErrorInfo, Notify};
use pipe::Pipe;
use stdin::SharedInput;

pub const FIRST_HANDLE: i32 = 0x4000_0000;
const MAX_CHILDREN: usize = 4;

pub struct Runtime {
    pub engine: wasmtime::Engine,
    pub module: wasmtime::Module,
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
            active: AtomicUsize::new(0),
        })
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
}

struct Child {
    cancel: Arc<Cancellation>,
    result: Arc<Mutex<Option<i32>>>,
    thread: Option<JoinHandle<()>>,
    pipes: [i32; 3],
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
    next: i32,
    children: HashMap<i32, Child>,
    pipes: HashMap<i32, PipeHandle>,
}

fn error(message: impl Into<String>, code: &str) -> ErrorInfo {
    ErrorInfo::new("Error", message, Some(code))
}

impl Processes {
    pub fn new(runtime: Arc<Runtime>, stdio: Stdio, notify: Arc<Notify>) -> Self {
        Self {
            runtime,
            stdin: stdio.stdin.clone(),
            stdio,
            notify,
            next: FIRST_HANDLE,
            children: HashMap::new(),
            pipes: HashMap::new(),
        }
    }

    fn next(&mut self) -> i32 {
        let id = self.next;
        self.next += 1;
        id
    }

    fn pipe(&mut self, write: bool) -> (i32, Pipe) {
        let id = self.next();
        let pipe = Pipe::new(self.notify.clone());
        self.pipes.insert(
            id,
            PipeHandle {
                pipe: pipe.clone(),
                write,
            },
        );
        (id, pipe)
    }

    fn stdin(&mut self, mode: &str) -> Result<(i32, SharedInput), ErrorInfo> {
        match mode {
            "inherit" => Ok((0, self.stdio.stdin.clone())),
            "ignore" => Ok((0, SharedInput::new(Arc::new(wasmtime_wasi::p2::pipe::MemoryInputPipe::new(Vec::new()))))),
            "pipe" => {
                let (id, pipe) = self.pipe(true);
                Ok((id, SharedInput::new(Arc::new(pipe))))
            }
            _ => Err(error("Unsupported stdin mode in bun-wasm", "EINVAL")),
        }
    }

    fn output(&mut self, mode: &str, fd: usize) -> Result<(i32, Arc<dyn StdoutStream + Sync>), ErrorInfo> {
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
                let (id, pipe) = self.pipe(false);
                Ok((id, Arc::new(pipe)))
            }
            _ => Err(error("Unsupported output mode in bun-wasm", "EINVAL")),
        }
    }

    pub fn spawn(&mut self, meta: &[u8]) -> Result<i32, ErrorInfo> {
        let request: Request = serde_json::from_slice(meta).map_err(|e| error(e.to_string(), "EINVAL"))?;
        let command = request.argv.first().map(String::as_str).unwrap_or("");
        if !matches!(command, "bun" | "/bun") {
            return Err(error(
                format!("spawn {command} ENOENT: only bun is supported in bun-wasm"),
                "ENOENT",
            ));
        }
        let cwd = std::path::Path::new(&request.cwd);
        if !cwd.is_absolute() || cwd.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(error("Child cwd must be an absolute normalized guest path", "EINVAL"));
        }
        let mapped = self
            .runtime
            .dirs
            .iter()
            .filter_map(|(host, guest)| cwd.strip_prefix(guest).ok().map(|rest| (guest.len(), host.join(rest))))
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
        self.runtime
            .active
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_CHILDREN).then_some(n + 1)
            })
            .map_err(|_| error("bun-wasm child concurrency limit reached (4 active children)", "EAGAIN"))?;
        let result = self.start(request);
        if result.is_err() {
            self.runtime.active.fetch_sub(1, Ordering::SeqCst);
        }
        result
    }

    fn start(&mut self, mut request: Request) -> Result<i32, ErrorInfo> {
        request.env.insert("PWD".into(), request.cwd.clone());
        let (stdin_id, stdin) = self.stdin(&request.stdin)?;
        let (stdout_id, stdout) = self.output(&request.stdout, 1)?;
        let (stderr_id, stderr) = self.output(&request.stderr, 2)?;
        let pipes = [stdin_id, stdout_id, stderr_id];
        let input = self.pipes.get(&stdin_id).map(|handle| handle.pipe.clone());
        let outputs: Vec<Pipe> = pipes[1..]
            .iter()
            .filter_map(|id| self.pipes.get(id).map(|p| p.pipe.clone()))
            .collect();
        let result = Arc::new(Mutex::new(None));
        let cancel = Arc::new(Cancellation::default());
        let (runtime, notify, completed, cancellation) = (
            self.runtime.clone(),
            self.notify.clone(),
            result.clone(),
            cancel.clone(),
        );
        let thread = std::thread::Builder::new()
            .name("bun-wasm-child".into())
            .stack_size(crate::THREAD_STACK)
            .spawn(move || {
                let code = crate::run_instance(
                    runtime.clone(),
                    request.argv,
                    request.env.into_iter().collect(),
                    Stdio { stdin, stdout, stderr },
                    cancellation.clone(),
                );
                let signal = cancellation.signal.load(Ordering::SeqCst);
                let code = if signal != 0 {
                    128 + signal
                } else {
                    code.unwrap_or_else(|e| {
                        eprintln!("bun-wasm child: {e:#}");
                        1
                    })
                };
                if let Some(pipe) = input {
                    pipe.close_reader();
                }
                for pipe in outputs {
                    pipe.close_writer();
                }
                *completed.lock().unwrap() = Some(code);
                runtime.active.fetch_sub(1, Ordering::SeqCst);
                notify.bump();
            });
        let thread = match thread {
            Ok(thread) => thread,
            Err(cause) => {
                self.close_pipes(pipes);
                return Err(error(cause.to_string(), "EAGAIN"));
            }
        };
        let id = self.next();
        self.children.insert(
            id,
            Child {
                cancel,
                result,
                thread: Some(thread),
                pipes,
            },
        );
        Ok(id)
    }

    fn close_pipes(&mut self, pipes: [i32; 3]) {
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
        let Some(code) = *child.result.lock().unwrap() else {
            return AGAIN;
        };
        if let Some(thread) = child.thread.take() {
            let _ = thread.join();
        }
        code
    }

    pub fn child_pipe(&self, id: i32, fd: i32) -> i32 {
        self.children
            .get(&id)
            .and_then(|c| c.pipes.get(fd as usize))
            .copied()
            .unwrap_or(BADF)
    }

    pub fn kill(&mut self, id: i32, signal: i32) -> i32 {
        if !(0..=64).contains(&signal) {
            return -1;
        }
        let Some(child) = self.children.get(&id) else {
            return BADF;
        };
        if child.result.lock().unwrap().is_some() {
            return BADF;
        }
        if signal != 0 {
            child.cancel.kill(signal);
        }
        self.notify.bump();
        0
    }

    pub fn error(&self, id: i32) -> crate::net::Output {
        let info = if let Some(pipe) = self.pipes.get(&id) {
            let info = error("Child process pipe is closed", "EPIPE");
            if pipe.write { info.with_errno(-32).with_syscall("write") } else { info }
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
