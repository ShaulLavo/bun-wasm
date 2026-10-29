mod descriptors;
mod executables;
mod pipe;
mod stdin;
mod stdio;
#[cfg(test)]
mod tests;
pub mod wasi;

pub use stdio::{Cancellation, FinalOutcome, Stdio};

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::net::Notify;
use descriptors::{Descriptors, Endpoint};

// Process descriptors are distinct from networking handles. No read/write slot
// dispatches by this boundary: only the runtime_proc descriptor ABI owns them.
pub const FIRST_HANDLE: i32 = 0x4000_0000;
pub const ACCES: i32 = -2;
pub const AGAIN: i32 = -6;
pub const BADF: i32 = -8;
pub const CHILD: i32 = -12;
pub const FAULT: i32 = -21;
pub const INTR: i32 = -27;
pub const INVAL: i32 = -28;
pub const IO: i32 = -29;
pub const NOENT: i32 = -44;
pub const NOSYS: i32 = -52;
pub const NOTDIR: i32 = -54;
pub const NOTSUP: i32 = -58;
const ROOT_JOB: i32 = i32::MAX;
pub const PERM: i32 = -63;
pub const PIPE: i32 = -64;
pub const SRCH: i32 = -71;
pub const NOTCAPABLE: i32 = -76;
// Waffle b1f2b7dd, proc/worker-client.ts:createWorkerProcessTransport defaults
// to 1024 directory slots and immediately reserves one for the root. Completed
// children retain a slot until consuming wait, just like the shared directory.
const PROCESS_CAPACITY: usize = 1024;
const MAX_ACCESS_REQUESTS: usize = 64;

pub(crate) fn validate_signal(signal: i32, probe: bool) -> Result<(), i32> {
    if (signal == 0 && probe) || ((1..=64).contains(&signal) && signal != 32 && signal != 33) {
        if (19..=22).contains(&signal) {
            Err(NOTSUP)
        } else {
            Ok(())
        }
    } else {
        Err(INVAL)
    }
}

pub struct Runtime {
    pub engine: wasmtime::Engine,
    pub module: wasmtime::Module,
    pub linked: crate::linked::Programs,
    pub tools_path: Option<std::path::PathBuf>,
    tools: std::sync::OnceLock<Result<wasmtime::Module, String>>,
    pub dirs: Vec<(std::path::PathBuf, String)>,
    pub thread_stack: usize,
    executables: executables::Executables,
    next_access: AtomicU32,
    access_threads: Mutex<Vec<JoinHandle<()>>>,
    state: Mutex<Supervisor>,
}

#[derive(Default)]
struct Supervisor {
    next: i32,
    stopping: bool,
    processes: HashMap<i32, Child>,
    // Retained ancestry is needed after an intermediate process/job is reaped.
    parents: HashMap<i32, i32>,
    jobs: HashMap<i32, Job>,
    reaped_jobs: HashSet<i32>,
}

impl Supervisor {
    /// Publish only after guest descriptor/context teardown. Like Waffle's safe-exit fence,
    /// collect completed orphans without discarding the job's independent leader outcome.
    fn complete(&mut self, pid: i32, outcome: FinalOutcome) {
        let child = self.processes.get_mut(&pid).expect("admitted child record");
        child.result = Some(outcome);
        if let Some(job) = self.jobs.get_mut(&child.job)
            && job.leader == pid
        {
            job.result = Some(outcome);
        }
        let orphans: Vec<_> = self
            .processes
            .iter()
            .filter_map(|(&pid, child)| {
                (child.result.is_some()
                    && child.parent != 0
                    && self
                        .processes
                        .get(&child.parent)
                        .is_none_or(|parent| parent.result.is_some()))
                .then_some(pid)
            })
            .collect();
        for pid in orphans {
            // The current thread may own this record; dropping its handle detaches only the
            // completed epilogue. Running descendants retain their records and shutdown joins.
            self.processes.remove(&pid);
        }
    }
}

struct Job {
    owner: i32,
    leader: i32,
    result: Option<FinalOutcome>,
}

struct Child {
    parent: i32,
    job: i32,
    cancel: Arc<Cancellation>,
    result: Option<FinalOutcome>,
    thread: Option<JoinHandle<()>>,
}

impl Runtime {
    pub fn new(
        engine: wasmtime::Engine,
        module: wasmtime::Module,
        mut dirs: Vec<(std::path::PathBuf, String)>,
    ) -> anyhow::Result<Arc<Self>> {
        let executables = executables::Executables::new(&module)?;
        dirs.extend(executables.mounts());
        Ok(Arc::new(Self {
            engine,
            module,
            linked: crate::linked::Programs::default(),
            dirs,
            tools_path: None,
            tools: std::sync::OnceLock::new(),
            thread_stack: crate::THREAD_STACK,
            executables,
            next_access: AtomicU32::new(1),
            access_threads: Mutex::default(),
            state: Mutex::new(Supervisor {
                next: 1,
                jobs: [(
                    ROOT_JOB,
                    Job {
                        owner: 0,
                        leader: 0,
                        result: None,
                    },
                )]
                .into_iter()
                .collect(),
                ..Supervisor::default()
            }),
        }))
    }

    pub fn register_engine(&self, name: &str, module: &wasmtime::Module) -> anyhow::Result<()> {
        let (_, paths) = executables::ENGINE_PATHS
            .iter()
            .find(|(engine, _)| *engine == name)
            .ok_or_else(|| anyhow::anyhow!("unknown engine {name:?}; expected quickjs or jsc"))?;
        self.executables.register(paths, module)?;
        Ok(())
    }
    /// bash-web's shell guest at /bin/sh and /bin/bash, for package scripts, Bun.$ and bun exec.
    pub fn register_shell(&self, module: &wasmtime::Module) -> anyhow::Result<()> {
        self.executables
            .register(&executables::SHELL_PATHS, module)?;
        Ok(())
    }
    /// bash-web's env utility at /bin/env and /usr/bin/env, for `#!/usr/bin/env node` bins.
    pub fn register_env(&self, module: &wasmtime::Module) -> anyhow::Result<()> {
        self.executables.register(&executables::ENV_PATHS, module)?;
        Ok(())
    }
    pub fn module_for<'a>(
        &'a self,
        argv: &[String],
        base: &'a wasmtime::Module,
    ) -> anyhow::Result<&'a wasmtime::Module> {
        if crate::tool_args::before_command(argv.get(1..).unwrap_or_default()).is_none() {
            return Ok(base);
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

    /// Root teardown owns every still-running child, even if its direct parent
    /// has exited. Keep epoch ticking until they have all joined.
    pub fn shutdown(&self) {
        let threads = {
            let mut state = self.state.lock().unwrap();
            state.stopping = true;
            for child in state.processes.values() {
                child.cancel.kill(9);
            }
            state
                .processes
                .values_mut()
                .filter_map(|child| child.thread.take())
                .collect::<Vec<_>>()
        };
        for thread in threads {
            let _ = thread.join();
        }
        self.state.lock().unwrap().processes.clear();
        for thread in self.access_threads.lock().unwrap().drain(..) {
            let _ = thread.join();
        }
    }
}

// This is Waffle's proc/types.ts SpawnRequest plus the Bun worker extension.
// Cross-language valid/invalid examples live in runtime-proc-spawn-requests.json.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub job: f64,
    pub fds: Vec<Binding>,
    #[serde(default)]
    worker: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct Binding {
    #[serde(deserialize_with = "descriptor_number")]
    pub child: i32,
    #[serde(deserialize_with = "descriptor_number")]
    pub parent: i32,
}

fn descriptor_number<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<i32, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if value.fract() != 0.0 || !(0.0..=i32::MAX as f64).contains(&value) {
        return Err(serde::de::Error::custom(
            "descriptor must be an integer in 0..=i32::MAX",
        ));
    }
    Ok(value as i32)
}

impl Request {
    fn decode(meta: &[u8]) -> Result<Self, i32> {
        let request: Self = serde_json::from_slice(meta).map_err(|_| INVAL)?;
        if request.executable.is_empty()
            || request.cwd.is_empty()
            || (request.job < -1.0 || request.job.fract() != 0.0)
            || request
                .fds
                .iter()
                .any(|binding| binding.child < 0 || binding.parent < 0)
        {
            return Err(INVAL);
        }
        Ok(request)
    }
}

pub struct Processes {
    runtime: Arc<Runtime>,
    pub pid: i32,
    fds: Descriptors,
    inherited: Vec<i32>,
    next: u32,
    notify: Arc<Notify>,
    cancel: Arc<Cancellation>,
    access: HashMap<i32, Arc<Mutex<AccessState>>>,
    /// The memory group this process is a member of; its workers join it.
    memory_group: Option<crate::shm::MemoryGroup>,
}

enum AccessState {
    Pending,
    Complete(i32),
    Cancelled,
}

impl Drop for Processes {
    fn drop(&mut self) {
        for request in self.access.values() {
            *request.lock().unwrap() = AccessState::Cancelled;
        }
    }
}

impl Processes {
    pub fn new(
        runtime: Arc<Runtime>,
        stdio: Stdio,
        notify: Arc<Notify>,
        cancel: Arc<Cancellation>,
    ) -> Self {
        if stdio.pid == 0 {
            runtime.state.lock().unwrap().processes.insert(
                0,
                Child {
                    parent: 0,
                    job: ROOT_JOB,
                    cancel: cancel.clone(),
                    result: None,
                    thread: None,
                },
            );
        }
        for endpoint in stdio.fds.values() {
            endpoint.observe(&notify);
        }
        let mut inherited: Vec<i32> = stdio.fds.keys().copied().collect();
        inherited.sort_unstable();
        let next = stdio
            .fds
            .keys()
            .map(|fd| *fd as u32 + 1)
            .max()
            .unwrap_or(0)
            .max(FIRST_HANDLE as u32);
        Self {
            runtime,
            pid: stdio.pid,
            fds: stdio.fds,
            inherited,
            next,
            notify,
            cancel,
            access: HashMap::new(),
            memory_group: None,
        }
    }

    /// Record the memory group this process joined, so the workers it spawns join it too.
    pub fn join_memory_group(&mut self, group: Option<crate::shm::MemoryGroup>) {
        self.memory_group = group;
    }

    /// Native metadata work runs off the import stack, with caller-owned,
    /// monotonic IDs and result-before-readiness publication.
    pub fn access_start(&mut self, path: &str, cwd: &str, mode: i32) -> i32 {
        if mode != 1
            || path.is_empty()
            || path.contains('\0')
            || !cwd.starts_with('/')
            || cwd.contains('\0')
        {
            return INVAL;
        }
        if self.access.len() >= MAX_ACCESS_REQUESTS {
            return AGAIN;
        }
        let Ok(id) =
            self.runtime
                .next_access
                .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| {
                    (id <= i32::MAX as u32).then(|| id + 1)
                })
        else {
            return AGAIN;
        };
        let id = id as i32;
        let request = Arc::new(Mutex::new(AccessState::Pending));
        let (slot, runtime, notify) = (request.clone(), self.runtime.clone(), self.notify.clone());
        let (path, cwd) = (path.to_string(), cwd.to_string());
        let thread = std::thread::Builder::new()
            .name("bun-wasm-access".into())
            .spawn(move || {
                let result = runtime.executables.access(&path, &cwd, &runtime.dirs);
                let mut state = slot.lock().unwrap();
                if matches!(*state, AccessState::Pending) {
                    *state = AccessState::Complete(result);
                    notify.bump();
                }
            });
        let Ok(thread) = thread else {
            return AGAIN;
        };
        let mut threads = self.runtime.access_threads.lock().unwrap();
        threads.retain(|thread| !thread.is_finished());
        threads.push(thread);
        self.access.insert(id, request);
        id
    }

    pub fn access_take(&mut self, id: i32) -> i32 {
        let Some(request) = self.access.get(&id) else {
            return BADF;
        };
        let result = match *request.lock().unwrap() {
            AccessState::Pending => return AGAIN,
            AccessState::Complete(result) => result,
            AccessState::Cancelled => return BADF,
        };
        self.access.remove(&id);
        result
    }

    pub fn access_cancel(&mut self, id: i32) -> i32 {
        let Some(request) = self.access.remove(&id) else {
            return BADF;
        };
        *request.lock().unwrap() = AccessState::Cancelled;
        0
    }

    fn access_ready(&self, id: i32) -> Result<bool, i32> {
        let request = self.access.get(&id).ok_or(BADF)?;
        Ok(matches!(*request.lock().unwrap(), AccessState::Complete(_)))
    }

    fn require_handles(&self, count: usize) -> Result<(), i32> {
        let available = (i32::MAX as u32 + 1).saturating_sub(self.next) as usize;
        if count > available {
            Err(AGAIN)
        } else {
            Ok(())
        }
    }

    fn insert(&mut self, endpoint: Arc<Endpoint>) -> i32 {
        let fd = self.next as i32;
        self.next += 1;
        self.fds.insert(fd, endpoint);
        fd
    }

    pub fn pipe(&mut self) -> Result<[i32; 2], i32> {
        self.require_handles(2)?;
        let [read, write] = Endpoint::pair(self.notify.clone());
        Ok([self.insert(read), self.insert(write)])
    }

    pub fn dup(&mut self, fd: i32) -> i32 {
        let Some(endpoint) = self.fds.get(&fd).cloned() else {
            return BADF;
        };
        if let Err(error) = self.require_handles(1) {
            return error;
        }
        self.insert(endpoint)
    }

    /// File descriptors share our external namespace. Like process renumber,
    /// reserving a file handle advances the monotonic allocator past that id.
    pub fn reserve_file(&mut self, fd: i32) {
        self.next = self.next.max(fd as u32 + 1);
    }

    pub fn preopen_count(&self) -> usize {
        self.runtime.dirs.len()
    }

    pub fn readiness(&self, fd: i32, write: bool) -> Result<(bool, bool), i32> {
        let endpoint = descriptors::get(&self.fds, fd)?;
        if endpoint.fdstat().1 & (1u64 << if write { 6 } else { 1 }) == 0 {
            return Err(NOTCAPABLE);
        }
        Ok(endpoint.readiness(write, &self.notify))
    }

    pub fn inherited_fd(&self, index: u32) -> i32 {
        self.inherited.get(index as usize).copied().unwrap_or(NOENT)
    }

    pub fn owns(&self, fd: i32) -> bool {
        self.fds.contains_key(&fd)
    }

    pub fn close(&mut self, fd: i32) -> i32 {
        if self.fds.remove(&fd).is_some() {
            0
        } else {
            BADF
        }
    }

    pub fn renumber(&mut self, from: i32, to: i32) -> i32 {
        if to < 0 {
            return INVAL;
        }
        let Some(endpoint) = self.fds.remove(&from) else {
            return BADF;
        };
        self.fds.insert(to, endpoint);
        self.next = self.next.max(to as u32 + 1);
        0
    }

    pub fn fd_kind(&self, fd: i32) -> i32 {
        self.fds.get(&fd).map_or(BADF, |endpoint| endpoint.kind())
    }

    pub fn fdstat(&self, fd: i32) -> Option<(bool, u64)> {
        self.fds.get(&fd).map(|endpoint| endpoint.fdstat())
    }

    pub fn read(&self, fd: i32, bytes: &mut [u8]) -> i32 {
        match descriptors::get(&self.fds, fd) {
            Ok(endpoint) => endpoint.read(bytes, &self.notify),
            Err(error) => error,
        }
    }

    pub fn write(&self, fd: i32, bytes: &[u8]) -> i32 {
        match descriptors::get(&self.fds, fd) {
            Ok(endpoint) => endpoint.write(bytes, &self.notify),
            Err(error) => error,
        }
    }

    pub fn spawn(&mut self, meta: &[u8]) -> i32 {
        match self.start(meta) {
            Ok(pid) => pid,
            Err(error) => error,
        }
    }

    fn start(&mut self, meta: &[u8]) -> Result<i32, i32> {
        let mut request = Request::decode(meta)?;
        if request.job > i32::MAX as f64 {
            return Err(SRCH);
        }
        let mut fds = Descriptors::new();
        for binding in &request.fds {
            if fds.contains_key(&binding.child) {
                return Err(INVAL);
            }
            // Never drop an unhandable filesystem fd or substitute stdio.
            fds.insert(
                binding.child,
                descriptors::get(&self.fds, binding.parent)?.clone(),
            );
        }
        let cwd = std::path::Path::new(&request.cwd);
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
        if !cwd.is_absolute()
            || cwd
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(INVAL);
        }
        // Revalidate the executable independently of an earlier access query. Startup failures
        // own an ordinary child record, with descriptors released before its typed publication.
        let startup = self
            .runtime
            .executables
            .resolve(
                &request.executable,
                &request.cwd,
                &self.runtime.dirs,
                request.argv.clone(),
            )
            .map_err(|errno| match errno {
                NOENT | ACCES | NOTDIR | -45 | -48 | AGAIN | IO => errno,
                PERM => ACCES,
                _ => IO,
            })
            .and_then(|module| {
                let path = mapped.ok_or(NOENT)?;
                let metadata = path.metadata().map_err(|error| -startup_io_errno(&error))?;
                if !metadata.is_dir() {
                    return Err(NOTDIR);
                }
                Ok(module)
            });
        let cancel = Arc::new(Cancellation::default());
        // Admission and thread-handle publication are one supervisor operation.
        // A very fast child can finish only after this lock is released.
        let mut state = self.runtime.state.lock().unwrap();
        if state.processes.len() >= PROCESS_CAPACITY {
            return Err(AGAIN);
        }
        if state.stopping {
            return Err(PERM);
        }
        if request.job > 0.0 && !state.jobs.contains_key(&(request.job as i32)) {
            return Err(SRCH);
        }
        if request.job > 0.0
            && state.jobs[&(request.job as i32)].result.is_some()
            && state
                .processes
                .values()
                .filter(|child| child.job == request.job as i32)
                .all(|child| child.result.is_some())
        {
            return Err(CHILD);
        }
        let Some(next) = state.next.checked_add(1) else {
            return Err(AGAIN);
        };
        let pid = state.next;
        state.next = next;
        // A group member's worker reserves its slot before its thread exists (W1).
        let admission = match &startup {
            Ok(resolved) => self.runtime.linked.worker_admission(
                self.memory_group.as_ref(),
                request.worker.is_some(),
                &resolved.module,
                pid as u32,
            )?,
            Err(_) => None,
        };
        let job = if request.job > 0.0 {
            request.job as i32
        } else {
            pid
        };
        let memory_limit = request
            .worker
            .as_ref()
            .and_then(|limits| limits.get("memoryLimitMb"))
            .and_then(serde_json::Value::as_u64)
            .map(|mb| {
                usize::try_from(mb)
                    .unwrap_or(usize::MAX)
                    .saturating_mul(1 << 20)
            })
            .unwrap_or(512 << 20);
        request.env.insert("PWD".into(), request.cwd.clone());
        let (runtime, notify, cancellation) =
            (self.runtime.clone(), self.notify.clone(), cancel.clone());
        let new_job = request.job <= 0.0;
        let thread = std::thread::Builder::new()
            .name("bun-wasm-child".into())
            .stack_size(runtime.thread_stack)
            .spawn(move || {
                // All owned descriptors and the WASI context drop before publication.
                let outcome = match startup {
                    Err(errno) => {
                        drop(fds);
                        cancellation.select(FinalOutcome::StartFailed(-errno))
                    }
                    Ok(executables::Resolved {
                        module,
                        path: executable,
                        argv,
                    }) => {
                        let stdio = Stdio {
                            fds,
                            pid,
                            memory_limit,
                        };
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            crate::run_module_instance(
                                runtime.clone(),
                                &module,
                                argv,
                                {
                                    let mut env = request.env;
                                    env.insert("BUNWASM_EXEC_PATH".into(), executable);
                                    env.into_iter().collect()
                                },
                                stdio,
                                cancellation.clone(),
                                admission,
                            )
                        }))
                        .unwrap_or_else(|_| {
                            Err(std::io::Error::other("child guest panicked").into())
                        })
                        .unwrap_or_else(|error| {
                            eprintln!("bun-wasm child: {error:#}");
                            let errno = error
                                .chain()
                                .find_map(|cause| cause.downcast_ref::<std::io::Error>())
                                .map(startup_io_errno)
                                .unwrap_or(45); // ENOEXEC: invalid module/entry point.
                            cancellation.select(FinalOutcome::StartFailed(errno))
                        })
                    }
                };
                let mut state = runtime.state.lock().unwrap();
                state.complete(pid, outcome);
                drop(state);
                notify.bump();
            });
        let thread = match thread {
            Ok(thread) => thread,
            Err(_) => {
                return Err(AGAIN);
            }
        };
        if new_job {
            state.jobs.insert(
                job,
                Job {
                    owner: self.pid,
                    leader: pid,
                    result: None,
                },
            );
        }
        state.parents.insert(pid, self.pid);
        state.processes.insert(
            pid,
            Child {
                parent: self.pid,
                job,
                cancel,
                result: None,
                thread: Some(thread),
            },
        );
        Ok(pid)
    }

    pub fn job_of(&self, pid: i32) -> i32 {
        let pid = if pid == 0 { self.pid } else { pid };
        self.runtime
            .state
            .lock()
            .unwrap()
            .processes
            .get(&pid)
            .map_or(SRCH, |child| child.job)
    }

    /// Non-consuming observation; terminal selection need not be safely published yet.
    pub fn start_status(&self, pid: i32) -> i32 {
        let state = self.runtime.state.lock().unwrap();
        state
            .processes
            .get(&pid)
            .filter(|child| child.parent == self.pid)
            .map_or(CHILD, |child| child.cancel.start_status())
    }

    /// Readiness observation never collects a child; only a successful wait does.
    fn child_outcome(&self, pid: i32) -> Result<FinalOutcome, i32> {
        let state = self.runtime.state.lock().unwrap();
        state
            .processes
            .get(&pid)
            .filter(|child| child.parent == self.pid)
            .ok_or(CHILD)?
            .result
            .ok_or(AGAIN)
    }

    /// Collect a completed direct child exactly once, retaining its job's leader outcome.
    pub fn wait(&self, pid: i32) -> Result<FinalOutcome, i32> {
        let (outcome, thread) = {
            let mut state = self.runtime.state.lock().unwrap();
            let child = state
                .processes
                .get(&pid)
                .filter(|child| child.parent == self.pid)
                .ok_or(CHILD)?;
            let outcome = child.result.ok_or(AGAIN)?;
            let child = state.processes.remove(&pid).unwrap();
            (outcome, child.thread)
        };
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        Ok(outcome)
    }

    fn authorized_job<'a>(&self, state: &'a Supervisor, job: i32) -> Result<&'a Job, i32> {
        let job = state.jobs.get(&job).ok_or_else(|| {
            if state.reaped_jobs.contains(&job) {
                CHILD
            } else {
                SRCH
            }
        })?;
        let mut owner = job.owner;
        loop {
            if owner == self.pid {
                return Ok(job);
            }
            if owner == 0 {
                return Err(PERM);
            }
            owner = *state.parents.get(&owner).ok_or(PERM)?;
        }
    }

    fn job_empty(&self, job: i32) -> Result<bool, i32> {
        let state = self.runtime.state.lock().unwrap();
        let record = self.authorized_job(&state, job)?;
        Ok(record.result.is_some()
            && state
                .processes
                .values()
                .filter(|child| child.job == job)
                .all(|child| child.result.is_some()))
    }

    /// Flags: 0 waits, 1 polls, 2 is Waffle's CLEANUP wait, which a pending handled signal does
    /// not interrupt and which cannot wait for the caller's own job.
    pub fn wait_job(&self, job: i32, flags: i32) -> Result<FinalOutcome, i32> {
        if !(0..=2).contains(&flags) || (flags == 2 && job == self.job_of(0)) {
            return Err(INVAL);
        }
        loop {
            if self.job_empty(job)? {
                let mut state = self.runtime.state.lock().unwrap();
                // Another ancestor may have reaped while the lock was released.
                let result = self.authorized_job(&state, job)?.result.ok_or(AGAIN)?;
                if state
                    .processes
                    .values()
                    .any(|child| child.job == job && child.result.is_none())
                {
                    continue;
                }
                let pids: Vec<i32> = state
                    .processes
                    .iter()
                    .filter_map(|(&pid, child)| (child.job == job).then_some(pid))
                    .collect();
                for pid in pids {
                    let mut child = state.processes.remove(&pid).unwrap();
                    if let Some(thread) = child.thread.take() {
                        let _ = thread.join();
                    }
                }
                state.jobs.remove(&job);
                state.reaped_jobs.insert(job);
                return Ok(result);
            }
            if flags == 1 {
                return Err(AGAIN);
            }
            let stopped = if flags == 2 {
                self.cancel.check().is_err()
            } else {
                self.cancel.interrupted()
            };
            if stopped {
                return Err(INTR);
            }
            // Signals use their own wake state; rescan them within 10ms without
            // consuming pending delivery or keeping the supervisor locked.
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    pub fn kill(&self, pid: i32, signal: i32) -> i32 {
        if let Err(error) = validate_signal(signal, true) {
            return error;
        }
        let state = self.runtime.state.lock().unwrap();
        let Some(child) = state.processes.get(&pid) else {
            return SRCH;
        };
        let mut target = pid;
        while target != self.pid {
            let Some(&parent) = state.parents.get(&target) else {
                return PERM;
            };
            target = parent;
        }
        child.cancel.kill(signal);
        self.notify.bump();
        0
    }

    pub fn kill_job(&self, job: i32, signal: i32) -> i32 {
        if let Err(error) = validate_signal(signal, true) {
            return error;
        }
        let state = self.runtime.state.lock().unwrap();
        let Some(record) = state.jobs.get(&job) else {
            return SRCH;
        };
        if record.owner != self.pid {
            return PERM;
        }
        for child in state.processes.values().filter(|child| child.job == job) {
            child.cancel.kill(signal);
        }
        self.notify.bump();
        0
    }

    /// Poll is level-triggered and never consumes a child or job result.
    pub fn poll(&self, subscriptions: &[u8], timeout: i32) -> Result<Vec<u8>, i32> {
        self.poll_with_files(subscriptions, timeout, |_| false)
    }

    /// Native filesystem operations are synchronous, so local files and
    /// directories are immediately ready just like canonical file resources.
    pub fn poll_with_files(
        &self,
        subscriptions: &[u8],
        timeout: i32,
        is_file: impl Fn(i32) -> bool,
    ) -> Result<Vec<u8>, i32> {
        if timeout < -1 || !subscriptions.len().is_multiple_of(16) {
            return Err(INVAL);
        }
        if subscriptions
            .as_chunks::<16>()
            .0
            .iter()
            .any(|sub| u32::from_le_bytes(sub[..4].try_into().unwrap()) > 6)
        {
            return Err(INVAL);
        }
        let deadline =
            (timeout >= 0).then(|| Instant::now() + Duration::from_millis(timeout as u64));
        loop {
            let seen = self.notify.generation();
            if self.cancel.interrupted() {
                return Ok(Vec::new());
            }
            let mut events = Vec::new();
            for sub in subscriptions.as_chunks::<16>().0.iter() {
                let kind = u32::from_le_bytes(sub[..4].try_into().unwrap());
                let id = i32::from_le_bytes(sub[4..8].try_into().unwrap());
                let (ready, hangup) = match kind {
                    0 | 1 if is_file(id) => (true, false),
                    0 | 1 => descriptors::get(&self.fds, id)?.readiness(kind == 1, &self.notify),
                    2 => match self.child_outcome(id) {
                        Ok(_) => (true, false),
                        Err(AGAIN) => (false, false),
                        Err(error) => return Err(error),
                    },
                    3 => return Err(NOSYS), // native WASI filesystem I/O completes synchronously
                    4 => (self.job_empty(id)?, false),
                    5 => (self.access_ready(id)?, false),
                    6 => match self.start_status(id) {
                        AGAIN => (false, false),
                        CHILD => return Err(CHILD),
                        _ => (true, false),
                    },
                    _ => return Err(INVAL),
                };
                if ready || hangup {
                    events.extend_from_slice(&sub[8..16]);
                    events.extend_from_slice(&kind.to_le_bytes());
                    events.extend_from_slice(&u32::from(hangup).to_le_bytes());
                }
            }
            if !events.is_empty() || deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return Ok(events);
            }
            let left = deadline.map_or(Duration::from_millis(10), |deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(10))
            });
            // Pipe wakers and child completions bump `notify`, ending the wait at once. Changes
            // that do not (cancellation, write space) keep the 10 ms rescan bound.
            self.notify.wait_past(seen, left);
        }
    }
}

/// Map host I/O failures into the seven portable startup errors in runtime_proc.
fn startup_io_errno(error: &std::io::Error) -> i32 {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => 44,
        ErrorKind::PermissionDenied => 2,
        ErrorKind::NotADirectory => 54,
        ErrorKind::OutOfMemory => 48,
        ErrorKind::WouldBlock => 6,
        _ => 29,
    }
}
