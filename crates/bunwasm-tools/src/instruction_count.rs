use std::ffi::{CString, c_int, c_long, c_void};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

#[cfg(target_arch = "x86_64")]
const PERF_EVENT_OPEN: c_long = 298;
#[cfg(target_arch = "aarch64")]
const PERF_EVENT_OPEN: c_long = 241;
static SIGNAL: AtomicI32 = AtomicI32::new(0);

unsafe extern "C" {
    fn syscall(number: c_long, ...) -> c_long;
    fn fork() -> c_int;
    fn pipe2(fds: *mut c_int, flags: c_int) -> c_int;
    fn read(fd: c_int, buf: *mut c_void, count: usize) -> isize;
    fn close(fd: c_int) -> c_int;
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
    fn execvp(file: *const i8, argv: *const *const i8) -> c_int;
    fn _exit(status: c_int) -> !;
    fn setpgid(pid: c_int, pgid: c_int) -> c_int;
    fn prctl(option: c_int, ...) -> c_int;
    fn kill(pid: c_int, signal: c_int) -> c_int;
    fn signal(signal: c_int, handler: usize) -> usize;
    fn wait4(pid: c_int, status: *mut c_int, options: c_int, usage: *mut c_long) -> c_int;
}

#[repr(C)]
#[derive(Default)]
struct Attr {
    kind: u32,
    size: u32,
    config: u64,
    sample_period: u64,
    sample_type: u64,
    read_format: u64,
    flags: u64,
    wakeup: u32,
    bp_type: u32,
    config1: u64,
}

struct Counter {
    file: File,
    pmu: String,
    event: &'static str,
}

#[derive(Debug)]
struct Count {
    value: u64,
    enabled: u64,
    running: u64,
}

impl Count {
    fn validate(&self) -> Result<(), String> {
        if self.running > self.enabled || self.enabled == 0 && self.value != 0 {
            return Err("invalid counter times".into());
        }
        // An unused hybrid PMU has zero time. Active counters need >= 99% coverage.
        if self.enabled > 0 && (self.running as u128) * 100 < (self.enabled as u128) * 99 {
            return Err("materially multiplexed counter: running/enabled below 0.99".into());
        }
        Ok(())
    }
}

fn os_error(context: &str) -> String {
    format!("{context}: {}", io::Error::last_os_error())
}

fn pmus() -> Result<Vec<(String, u64)>, String> {
    let core = "/sys/bus/event_source/devices/cpu_core/type";
    let atom = "/sys/bus/event_source/devices/cpu_atom/type";
    if !fs::exists(core).map_err(|e| e.to_string())? && !fs::exists(atom).map_err(|e| e.to_string())? {
        return Ok(vec![("cpu".into(), 0)]);
    }
    [core, atom].into_iter().map(|path| {
        let kind: u64 = fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?
            .trim().parse().map_err(|e| format!("{path}: {e}"))?;
        Ok((if path == core { "cpu_core" } else { "cpu_atom" }.into(), kind << 32))
    }).collect()
}

fn counters(pid: c_int) -> Result<Vec<Counter>, String> {
    let mut counters = Vec::new();
    for (pmu, config) in pmus()? {
        for (event, event_id) in [("instructions", 1), ("cycles", 0)] {
            counters.push(open_counter(pid, &pmu, config | event_id, event)?);
        }
    }
    Ok(counters)
}

fn open_counter(pid: c_int, pmu: &str, config: u64, event: &'static str) -> Result<Counter, String> {
    let attr = Attr {
        kind: 0, size: size_of::<Attr>() as u32, config,
        read_format: 3,
        // disabled, inherit, exclude_kernel, exclude_hv, inherit_stat, enable_on_exec.
        flags: 1 | 2 | (1 << 5) | (1 << 6) | (1 << 11) | (1 << 12),
        ..Attr::default()
    };
    let fd = unsafe { syscall(PERF_EVENT_OPEN, &attr, pid, -1i32, -1i32, 8u64) };
    if fd < 0 { return Err(os_error(&format!("perf_event_open {pmu}/{event}"))); }
    Ok(Counter { file: unsafe { File::from_raw_fd(fd as c_int) }, pmu: pmu.into(), event })
}

fn read_count(counter: &mut Counter) -> Result<Count, String> {
    let mut bytes = [0u8; 24];
    counter.file.read_exact(&mut bytes).map_err(|e| format!("read {}/{}: {e}", counter.pmu, counter.event))?;
    let mut words = bytes.chunks_exact(8).map(|word| u64::from_ne_bytes(word.try_into().unwrap()));
    let count = Count { value: words.next().unwrap(), enabled: words.next().unwrap(), running: words.next().unwrap() };
    count.validate()?;
    Ok(count)
}

struct Tree {
    pid: c_int,
    gate: Option<OwnedFd>,
    finished: bool,
}

fn spawn_tree(args: &[String]) -> Result<Tree, String> {
    let strings: Vec<CString> = args.iter().map(|arg| CString::new(arg.as_bytes()).map_err(|e| e.to_string())).collect::<Result<_, _>>()?;
    let argv: Vec<*const i8> = strings.iter().map(|s| s.as_ptr()).chain(std::iter::once(std::ptr::null())).collect();
    let mut gate = [0; 2];
    if unsafe { pipe2(gate.as_mut_ptr(), 0o2000000) } != 0 { return Err(os_error("pipe2")); }
    let read_end = unsafe { OwnedFd::from_raw_fd(gate[0]) };
    let write_end = unsafe { OwnedFd::from_raw_fd(gate[1]) };
    let pid = unsafe { fork() };
    if pid < 0 { return Err(os_error("fork")); }
    if pid == 0 { unsafe { child_exec(gate, &argv) }; }
    drop(read_end);
    Ok(Tree { pid, gate: Some(write_end), finished: false })
}

unsafe fn child_exec(gate: [c_int; 2], argv: &[*const i8]) -> ! {
    unsafe {
        close(gate[1]);
        if setpgid(0, 0) != 0 { _exit(126); }
        let mut byte = 0u8;
        if read(gate[0], (&mut byte as *mut u8).cast(), 1) != 1 { _exit(126); }
        close(gate[0]);
        execvp(argv[0], argv.as_ptr());
        _exit(127);
    }
}

impl Tree {
    fn release(&mut self) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        let gate = self.gate.take().ok_or("child already released")?;
        if unsafe { write(gate.as_raw_fd(), b"g".as_ptr().cast(), 1) } != 1 { return Err(os_error("release child")); }
        Ok(())
    }

    fn stop(&self) {
        unsafe { kill(-self.pid, 9); }
        // Subreaper adoption also covers descendants that created a new session.
        let path = format!("/proc/self/task/{}/children", std::process::id());
        let children = fs::read_to_string(path).expect("read subreaper children");
        for pid in children.split_whitespace().filter_map(|s| s.parse::<c_int>().ok()) {
            unsafe { kill(pid, 9); }
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        if self.finished { return; }
        self.gate.take();
        loop {
            self.stop();
            let mut status = 0;
            let pid = unsafe { wait4(-1, &mut status, 1, std::ptr::null_mut()) };
            if pid < 0 && io::Error::last_os_error().raw_os_error() == Some(10) { break; }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[derive(Default)]
struct Outcome {
    exit: Option<i32>,
    user: f64,
    system: f64,
    max_rss: c_long,
    reaped: u64,
}

fn supervise(tree: &mut Tree, timeout: Duration) -> Result<Outcome, String> {
    let started = Instant::now();
    let mut outcome = Outcome::default();
    loop {
        if SIGNAL.load(Ordering::Relaxed) != 0 { return Err(format!("interrupted by signal {}", SIGNAL.load(Ordering::Relaxed))); }
        if started.elapsed() >= timeout { return Err("process-tree timeout".into()); }
        if reap(tree.pid, &mut outcome)? { break; }
        std::thread::sleep(Duration::from_millis(5));
    }
    tree.finished = true;
    Ok(outcome)
}

fn reap(root: c_int, outcome: &mut Outcome) -> Result<bool, String> {
    let mut status = 0;
    // Linux 64-bit rusage: two timevals, then fourteen longs.
    let mut usage = [0 as c_long; 18];
    let pid = unsafe { wait4(-1, &mut status, 1, usage.as_mut_ptr()) };
    if pid == 0 { return Ok(false); }
    if pid < 0 && io::Error::last_os_error().raw_os_error() == Some(10) { return Ok(true); }
    if pid < 0 && io::Error::last_os_error().raw_os_error() == Some(4) { return Ok(false); }
    if pid < 0 { return Err(os_error("wait4")); }
    outcome.reaped += 1;
    outcome.user += usage[0] as f64 + usage[1] as f64 / 1e6;
    outcome.system += usage[2] as f64 + usage[3] as f64 / 1e6;
    outcome.max_rss = outcome.max_rss.max(usage[4]);
    if pid == root { outcome.exit = Some(if status & 127 == 0 { status >> 8 } else { 128 + (status & 127) }); }
    Ok(false)
}

extern "C" fn handle_signal(signal: c_int) { SIGNAL.store(signal, Ordering::Relaxed); }

fn setup() -> Result<(), String> {
    if unsafe { prctl(36, 1 as c_long, 0 as c_long, 0 as c_long, 0 as c_long) } != 0 { return Err(os_error("PR_SET_CHILD_SUBREAPER")); }
    for sig in [1, 2, 15] {
        if unsafe { signal(sig, handle_signal as usize) } == usize::MAX { return Err(os_error("signal")); }
    }
    Ok(())
}

fn capture(args: &[String], seconds: f64) -> Result<String, String> {
    setup()?;
    let mut tree = spawn_tree(args)?;
    let mut events = counters(tree.pid)?;
    let started = Instant::now();
    tree.release()?;
    let outcome = supervise(&mut tree, Duration::from_secs_f64(seconds))?;
    let mut rows = Vec::new();
    let mut instructions = 0u64;
    let mut cycles = 0u64;
    for event in &mut events {
        let count = read_count(event)?;
        if event.event == "instructions" { instructions += count.value; } else { cycles += count.value; }
        rows.push(format!("{{\"pmu\":{:?},\"event\":{:?},\"value\":{},\"enabledNs\":{},\"runningNs\":{}}}", event.pmu, event.event, count.value, count.enabled, count.running));
    }
    if instructions == 0 || cycles == 0 { return Err("zero aggregate instructions or cycles".into()); }
    Ok(format!("{{\"valid\":true,\"exit\":{},\"instructions\":{instructions},\"cycles\":{cycles},\"wallSeconds\":{},\"userSeconds\":{},\"systemSeconds\":{},\"maxRssKiB\":{},\"reapedProcesses\":{},\"events\":[{}]}}\n", outcome.exit.ok_or("missing root exit")?, started.elapsed().as_secs_f64(), outcome.user, outcome.system, outcome.max_rss, outcome.reaped, rows.join(",")))
}

pub fn main() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((output, rest)) = args.split_first() else { eprintln!("usage: instruction-count OUTPUT.json TIMEOUT_SECONDS COMMAND [ARG...]"); return 2; };
    let Some((seconds, command)) = rest.split_first() else { return 2; };
    let seconds: f64 = match seconds.parse() { Ok(n) if n > 0.0 && n <= 86400.0 => n, _ => return 2 };
    if command.is_empty() { return 2; }
    let mut output = match OpenOptions::new().write(true).create_new(true).open(output) { Ok(f) => f, Err(e) => { eprintln!("output: {e}"); return 2; } };
    let result = capture(command, seconds);
    let (text, exit) = match result {
        Ok(text) => (text, 0),
        Err(error) => { eprintln!("{error}"); (format!("{{\"valid\":false,\"error\":{error:?}}}\n"), 2) }
    };
    if let Err(e) = output.write_all(text.as_bytes()) { eprintln!("write output: {e}"); return 2; }
    exit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_and_multiplexed_counts() {
        for (value, enabled, running) in [(1, 0, 0), (1, 10, 11), (100, 1000, 989), (0, 1, 0)] {
            assert!(Count { value, enabled, running }.validate().is_err());
        }
        assert!(Count { value: 100, enabled: 1000, running: 990 }.validate().is_ok());
        assert!(Count { value: 0, enabled: 0, running: 0 }.validate().is_ok());
    }
}
