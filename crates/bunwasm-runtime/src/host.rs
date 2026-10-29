//! The `bun_wasm` host ABI (docs/host-abi.md): optional networking functions
//! a host installs into the function table before `_start`.
//!
//! The guest exports `bun_wasm_host_slots`, the address of [`HostSlots`].
//! A host appends its functions to `__indirect_function_table` and writes
//! their table indices into the slots; 0 means "not provided". Under plain
//! `wasmtime run` every slot stays 0 and network APIs report "unsupported".

use std::ptr::{addr_of, addr_of_mut, read_volatile};

pub const ABI_VERSION: u32 = 2;
pub const SLOT_COUNT: usize = 18;

pub const ERROR: i32 = -1;
pub const AGAIN: i32 = -2;
pub const UNSUPPORTED: i32 = -4;

/// Slot numbers, in ABI order.
#[derive(Clone, Copy)]
#[repr(usize)]
pub enum Slot {
    Poll = 0,
    Fetch = 1,
    FetchHead = 2,
    Read = 3,
    Write = 4,
    Close = 5,
    Listen = 6,
    LocalPort = 7,
    Accept = 8,
    Connect = 9,
    Error = 10,
    PeerAddr = 11,
    Shutdown = 12,
    LocalAddr = 13,
    LookupStart = 14,
    LookupHead = 15,
    ListenPath = 16,
    ConnectPath = 17,
}

pub const SLOT_NAMES: [&str; SLOT_COUNT] = [
    "poll",
    "fetch",
    "fetch_head",
    "read",
    "write",
    "close",
    "listen",
    "local_port",
    "accept",
    "connect",
    "error",
    "peer_addr",
    "shutdown",
    "local_addr",
    "lookup_start",
    "lookup_head",
    "listen_path",
    "connect_path",
];

#[repr(C)]
pub struct HostSlots {
    version: u32,
    count: u32,
    slots: [u32; SLOT_COUNT],
}

static mut HOST_SLOTS: HostSlots = HostSlots {
    version: ABI_VERSION,
    count: SLOT_COUNT as u32,
    slots: [0; SLOT_COUNT],
};

/// Exported (see crates/bunwasm-cli/build.rs) for hosts to fill in.
#[unsafe(no_mangle)]
pub extern "C" fn bun_wasm_host_slots() -> *mut HostSlots {
    addr_of_mut!(HOST_SLOTS)
}

pub fn provided(slot_number: usize) -> bool {
    slot_number < SLOT_COUNT
        && unsafe { read_volatile(addr_of!(HOST_SLOTS.slots[slot_number])) } != 0
}

type F2 = extern "C" fn(i32, i32) -> i32;
type F1 = extern "C" fn(i32) -> i32;
type F3 = extern "C" fn(i32, i32, i32) -> i32;
type F4 = extern "C" fn(i32, i32, i32, i32) -> i32;

/// A slot value meaning "provided, but call it through an import": the host
/// answers `sock_send` on [`HOST_CALL_FD`] instead of putting a function into
/// the table. For hosts where a cross-module function in the table traps
/// (docs/host-abi.md, "Calling through an import").
const VIA_IMPORT: u32 = u32::MAX;
/// The fd a host-call `sock_send` names. No real descriptor gets this number.
#[cfg(target_arch = "wasm32")]
const HOST_CALL_FD: i32 = 0x7fff_b0b0;

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "wasi_snapshot_preview1")]
unsafe extern "C" {
    /// WASI's `sock_send(fd, si_data, si_data_len, si_flags, so_datalen)`,
    /// borrowed as a host call: `si_data` points at `[slot, a, b, c, d]`,
    /// `si_data_len` is 5, and the result goes to `so_datalen`.
    #[link_name = "sock_send"]
    fn wasi_sock_send(
        fd: i32,
        si_data: i32,
        si_data_len: i32,
        si_flags: i32,
        so_datalen: i32,
    ) -> i32;
}

/// Calls slot `id` with `args` (unused ones 0), or None when not provided.
/// Slots are read volatile: the host writes them from outside the program,
/// which the optimizer can't see.
fn call(id: Slot, args: [i32; 4]) -> Option<i32> {
    // SAFETY: plain read of a static only the host writes, before `_start`.
    let index = unsafe { read_volatile(addr_of!(HOST_SLOTS.slots[id as usize])) };
    if index == 0 {
        return None;
    }
    if index == VIA_IMPORT {
        #[cfg(target_arch = "wasm32")]
        {
            let packet = [id as i32, args[0], args[1], args[2], args[3]];
            let mut result: i32 = UNSUPPORTED;
            // SAFETY: both pointers are valid for the call; the host reads 5 i32s and writes one.
            let errno = unsafe {
                wasi_sock_send(
                    HOST_CALL_FD,
                    packet.as_ptr() as i32,
                    5,
                    0,
                    addr_of_mut!(result) as i32,
                )
            };
            return Some(if errno == 0 { result } else { UNSUPPORTED });
        }
        #[cfg(not(target_arch = "wasm32"))]
        return Some(UNSUPPORTED);
    }
    // On wasm32 a function pointer is a table index, so a slot's index can be
    // called as a function of the documented signature.
    // SAFETY: the host installed a function with this signature
    // (docs/host-abi.md); a mismatch traps in call_indirect.
    Some(unsafe {
        match id {
            Slot::Poll | Slot::Close | Slot::LocalPort | Slot::Accept | Slot::Shutdown => {
                std::mem::transmute::<usize, F1>(index as usize)(args[0])
            }
            Slot::ConnectPath => std::mem::transmute::<usize, F2>(index as usize)(args[0], args[1]),
            Slot::Fetch | Slot::LookupStart => {
                std::mem::transmute::<usize, F4>(index as usize)(args[0], args[1], args[2], args[3])
            }
            Slot::FetchHead
            | Slot::Read
            | Slot::Write
            | Slot::Listen
            | Slot::Connect
            | Slot::Error
            | Slot::PeerAddr
            | Slot::LocalAddr
            | Slot::LookupHead
            | Slot::ListenPath => {
                std::mem::transmute::<usize, F3>(index as usize)(args[0], args[1], args[2])
            }
        }
    })
}

fn ptr(bytes: &[u8]) -> i32 {
    bytes.as_ptr() as usize as i32
}

fn ptr_mut<T>(values: &mut [T]) -> i32 {
    values.as_mut_ptr() as usize as i32
}

pub fn poll(timeout_ms: i32) -> i32 {
    call(Slot::Poll, [timeout_ms, 0, 0, 0]).unwrap_or(UNSUPPORTED)
}

pub fn fetch(meta: &[u8], body: &[u8]) -> i32 {
    call(
        Slot::Fetch,
        [ptr(meta), meta.len() as i32, ptr(body), body.len() as i32],
    )
    .unwrap_or(UNSUPPORTED)
}

/// Calls a `(handle, buf, cap) -> len` function, growing the buffer when the
/// host reports a longer result. Returns the bytes or the negative code.
fn read_sized(slot_id: Slot, handle: i32) -> Result<Vec<u8>, i32> {
    let mut buf = vec![0u8; 1024];
    loop {
        let n = call(slot_id, [handle, ptr(&buf), buf.len() as i32, 0]).ok_or(UNSUPPORTED)?;
        if n < 0 {
            return Err(n);
        }
        let n = n as usize;
        if n <= buf.len() {
            buf.truncate(n);
            return Ok(buf);
        }
        buf.resize(n, 0);
    }
}

pub fn fetch_head(handle: i32) -> Result<Vec<u8>, i32> {
    read_sized(Slot::FetchHead, handle)
}

pub fn lookup_start(hostname: &str, family: i32, hints: i32) -> i32 {
    call(
        Slot::LookupStart,
        [
            ptr(hostname.as_bytes()),
            hostname.len() as i32,
            family,
            hints,
        ],
    )
    .unwrap_or(UNSUPPORTED)
}

pub fn lookup_head(handle: i32) -> Result<Vec<u8>, i32> {
    read_sized(Slot::LookupHead, handle)
}

pub fn error(handle: i32) -> Result<Vec<u8>, i32> {
    read_sized(Slot::Error, handle)
}

pub fn peer_addr(handle: i32) -> Result<Vec<u8>, i32> {
    read_sized(Slot::PeerAddr, handle)
}

pub fn read(handle: i32, cap: usize) -> Result<Vec<u8>, i32> {
    let mut buf = vec![0u8; cap];
    let n = call(Slot::Read, [handle, ptr(&buf), cap as i32, 0]).ok_or(UNSUPPORTED)?;
    if n < 0 {
        return Err(n);
    }
    buf.truncate(n as usize);
    Ok(buf)
}

pub fn write(handle: i32, data: &[u8]) -> i32 {
    call(Slot::Write, [handle, ptr(data), data.len() as i32, 0]).unwrap_or(UNSUPPORTED)
}

pub fn close(handle: i32) -> i32 {
    call(Slot::Close, [handle, 0, 0, 0]).unwrap_or(UNSUPPORTED)
}

pub fn listen(host: &str, port: i32) -> i32 {
    call(
        Slot::Listen,
        [ptr(host.as_bytes()), host.len() as i32, port, 0],
    )
    .unwrap_or(UNSUPPORTED)
}

pub fn local_port(handle: i32) -> i32 {
    call(Slot::LocalPort, [handle, 0, 0, 0]).unwrap_or(UNSUPPORTED)
}

pub fn accept(listener: i32) -> i32 {
    call(Slot::Accept, [listener, 0, 0, 0]).unwrap_or(UNSUPPORTED)
}

pub fn shutdown(handle: i32) -> i32 {
    call(Slot::Shutdown, [handle, 0, 0, 0]).unwrap_or(UNSUPPORTED)
}

pub fn local_addr(handle: i32) -> Result<Vec<u8>, i32> {
    read_sized(Slot::LocalAddr, handle)
}

pub fn connect(host: &str, port: i32) -> i32 {
    call(
        Slot::Connect,
        [ptr(host.as_bytes()), host.len() as i32, port, 0],
    )
    .unwrap_or(UNSUPPORTED)
}

pub fn listen_path(path: &str, flags: i32) -> i32 {
    call(
        Slot::ListenPath,
        [ptr(path.as_bytes()), path.len() as i32, flags, 0],
    )
    .unwrap_or(UNSUPPORTED)
}

pub fn connect_path(path: &str) -> i32 {
    call(
        Slot::ConnectPath,
        [ptr(path.as_bytes()), path.len() as i32, 0, 0],
    )
    .unwrap_or(UNSUPPORTED)
}

/// The `runtime_proc` process ABI (docs/host-abi.md, "Process imports"). These are real wasm
/// imports, not optional slots: a host that runs the guest provides the namespace. Results are
/// `>= 0` or a negative WASI errno.
#[cfg(target_arch = "wasm32")]
mod runtime_proc {
    #[link(wasm_import_module = "runtime_proc")]
    unsafe extern "C" {
        pub fn access_start(path: i32, path_len: i32, cwd: i32, cwd_len: i32, mode: i32) -> i32;
        pub fn access_take(request: i32) -> i32;
        pub fn access_cancel(request: i32) -> i32;
        pub fn spawn(desc_ptr: i32, desc_len: i32) -> i32;
        pub fn job_of(pid: i32) -> i32;
        pub fn start_status(pid: i32) -> i32;
        pub fn pipe(out_ptr: i32) -> i32;
        pub fn fd_kind(fd: i32) -> i32;
        pub fn read(fd: i32, buf: i32, len: i32) -> i32;
        pub fn write(fd: i32, buf: i32, len: i32) -> i32;
        pub fn wait(pid: i32, out_ptr: i32) -> i32;
        pub fn wait_job(job: i32, flags: i32, status_ptr: i32) -> i32;
        pub fn kill(pid: i32, sig: i32) -> i32;
        pub fn kill_job(job: i32, sig: i32) -> i32;
        pub fn poll(subs_ptr: i32, n: i32, timeout_ms: i32, out_ptr: i32) -> i32;
        pub fn signal(sig: i32, mode: i32) -> i32;
    }
    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    unsafe extern "C" {
        /// Every runtime descriptor, pipes included, closes through WASI (a positive errno).
        pub fn fd_close(fd: i32) -> i32;
    }
}

/// Host builds (unit tests) have no runtime_proc namespace: every call is `UNSUPPORTED`.
#[cfg(not(target_arch = "wasm32"))]
mod runtime_proc {
    use super::UNSUPPORTED;
    pub unsafe fn access_start(_: i32, _: i32, _: i32, _: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn access_take(_: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn access_cancel(_: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn spawn(_: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn job_of(_: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn start_status(_: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn fd_kind(_: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn pipe(_: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn read(_: i32, _: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn write(_: i32, _: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn wait(_: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn wait_job(_: i32, _: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn kill(_: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn kill_job(_: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn poll(_: i32, _: i32, _: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn signal(_: i32, _: i32) -> i32 {
        UNSUPPORTED
    }
    pub unsafe fn fd_close(_: i32) -> i32 {
        -UNSUPPORTED
    }
}

/// Whether this build imports the `runtime_proc` namespace (every wasm32 build does).
pub const PROCESS_ABI: bool = cfg!(target_arch = "wasm32");

// SAFETY (all calls below): arguments are valid guest pointers for the duration of the call, and
// the host implements the documented runtime_proc signatures.
macro_rules! proc_call {
    ($call:expr) => {
        unsafe { $call }
    };
}

/// Resolve live executable metadata through the host's asynchronous access query ABI.
/// Taking a completed result consumes it. Interrupted waits cancel their outstanding query.
pub fn proc_access(path: &str, cwd: &str) -> i32 {
    let request = proc_call!(runtime_proc::access_start(
        ptr(path.as_bytes()),
        path.len() as i32,
        ptr(cwd.as_bytes()),
        cwd.len() as i32,
        1
    ));
    if request < 0 {
        return request;
    }
    loop {
        let result = proc_call!(runtime_proc::access_take(request));
        if result != -6 {
            return result;
        }
        if let Err(error) = proc_poll(&[], 25) {
            proc_call!(runtime_proc::access_cancel(request));
            return error;
        }
    }
}

pub fn proc_spawn(request: &[u8]) -> i32 {
    proc_call!(runtime_proc::spawn(ptr(request), request.len() as i32))
}

pub fn proc_job_of(pid: i32) -> i32 {
    proc_call!(runtime_proc::job_of(pid))
}

/// Returns `(read, write)` descriptors, or the negative code.
pub fn proc_pipe() -> Result<(u32, u32), i32> {
    let mut ends = [0u32; 2];
    let result = proc_call!(runtime_proc::pipe(ptr_mut(&mut ends)));
    if result < 0 {
        Err(result)
    } else {
        Ok((ends[0], ends[1]))
    }
}

/// Non-consuming lookup of the underlying process descriptor resource.
pub fn proc_fd_kind(fd: i32) -> i32 {
    proc_call!(runtime_proc::fd_kind(fd))
}

pub fn proc_close(fd: i32) -> i32 {
    -proc_call!(runtime_proc::fd_close(fd))
}

/// Bytes read (empty at end of file), or the negative code. `cap` must be nonzero.
pub fn proc_read(fd: i32, cap: usize) -> Result<Vec<u8>, i32> {
    let mut buf = vec![0u8; cap];
    let n = proc_call!(runtime_proc::read(fd, ptr(&buf), cap as i32));
    if n < 0 {
        return Err(n);
    }
    buf.truncate(n as usize);
    Ok(buf)
}

pub fn proc_write(fd: i32, data: &[u8]) -> i32 {
    proc_call!(runtime_proc::write(fd, ptr(data), data.len() as i32))
}

/// Eight-byte completion: kind 0 exited, 1 signaled, 2 failed to start (positive WASI errno).
/// Successful waits consume the result; `Err(-EAGAIN)` means it is not yet safe to collect.
pub fn proc_wait(pid: i32) -> Result<(u32, i32), i32> {
    let mut status = [0i32; 2];
    let result = proc_call!(runtime_proc::wait(pid, ptr_mut(&mut status)));
    if result < 0 {
        Err(result)
    } else {
        Ok((status[0] as u32, status[1]))
    }
}

/// Non-consuming entry observation: 0 entered, -6 pending, positive startup errno,
/// -11 canceled before entry, -12 unknown/not owned/collected.
pub fn proc_start_status(pid: i32) -> i32 {
    proc_call!(runtime_proc::start_status(pid))
}

pub fn proc_wait_job(job: i32, flags: i32) -> Result<(u32, i32), i32> {
    let mut status = [0i32; 2];
    let result = proc_call!(runtime_proc::wait_job(job, flags, ptr_mut(&mut status)));
    if result < 0 {
        Err(result)
    } else {
        Ok((status[0] as u32, status[1]))
    }
}

pub fn proc_kill(pid: i32, signal: i32) -> i32 {
    proc_call!(runtime_proc::kill(pid, signal))
}

pub fn proc_kill_job(job: i32, signal: i32) -> i32 {
    proc_call!(runtime_proc::kill_job(job, signal))
}

/// Waits on 16-byte subscriptions and returns the 16-byte events that fired (possibly none).
pub fn proc_poll(subscriptions: &[u8], timeout_ms: i32) -> Result<Vec<u8>, i32> {
    let count = subscriptions.len() / 16;
    let mut events = vec![0u8; subscriptions.len()];
    let ready = proc_call!(runtime_proc::poll(
        ptr(subscriptions),
        count as i32,
        timeout_ms,
        ptr_mut(&mut events)
    ));
    if ready < 0 {
        return Err(ready);
    }
    events.truncate(ready as usize * 16);
    Ok(events)
}

/// `runtime_proc.signal(sig, mode)` (docs/host-abi.md, "Signal dispositions"). A selected default
/// action unwinds through the host instead of returning.
pub fn signal(signal: i32, operation: i32) -> i32 {
    proc_call!(runtime_proc::signal(signal, operation))
}

/// Waits for up to `timeout_ms` with nothing to watch except this process itself. `runtime_proc.poll`
/// with no subscriptions returns early for a handled signal or an interrupt, so idle timers and
/// `Bun.sleepSync` stay cancellable and signals wake an idle guest. Without the process ABI (host
/// unit tests) it is a plain sleep.
pub fn idle(timeout_ms: i32) {
    if proc_poll(&[], timeout_ms).is_err() {
        std::thread::sleep(std::time::Duration::from_millis(timeout_ms.max(0) as u64));
    }
}

/// Handled signals taken from the process service during a synchronous sleep, waiting for the
/// next JavaScript checkpoint. Node runs handled callbacks only on the event loop, never inside
/// `Bun.sleepSync`, but the service's pending state would make every poll return at once.
#[derive(Default)]
pub(crate) struct DeferredSignals {
    pending: u64,
}

impl DeferredSignals {
    pub(crate) fn defer(&mut self, signal: i32) {
        if (1..=64).contains(&signal) {
            self.pending |= 1u64 << (signal - 1);
        }
    }

    /// The lowest deferred signal, like the service's own dequeue order; 0 when none.
    pub(crate) fn take(&mut self) -> i32 {
        if self.pending == 0 {
            return 0;
        }
        let signal = self.pending.trailing_zeros() + 1;
        self.pending &= !(1u64 << (signal - 1));
        signal as i32
    }

    /// Withdraws one deferred signal; whether it was pending.
    pub(crate) fn withdraw(&mut self, signal: i32) -> bool {
        if !(1..=64).contains(&signal) {
            return false;
        }
        let bit = 1u64 << (signal - 1);
        let was = self.pending & bit != 0;
        self.pending &= !bit;
        was
    }
}

/// The next handled signal for the guest, lowest number first. Whatever the service still holds
/// pending is folded into `deferred` first, so a signal that arrived again while an earlier copy
/// was parked coalesces into one delivery (as the service's single pending bit would), and a
/// selected fatal outcome unwinds inside `dequeue` before any parked callback runs.
pub(crate) fn next_signal(deferred: &mut DeferredSignals, dequeue: impl FnMut() -> i32) -> i32 {
    drain_signals(deferred, dequeue);
    deferred.take()
}

/// Moves what the service holds into `deferred`. Standard signals coalesce, so at most one entry
/// per signal number is pending: draining stops after that many, even when a sender republishes
/// continually, and the caller always makes progress (a callback, or its deadline check).
fn drain_signals(deferred: &mut DeferredSignals, mut dequeue: impl FnMut() -> i32) {
    for _ in 0..SIGNAL_LIMIT {
        let signal = dequeue();
        if signal <= 0 {
            return;
        }
        deferred.defer(signal);
    }
}

/// Signal numbers 1 through 64.
const SIGNAL_LIMIT: usize = 64;

/// Sleep so child cancellation and signals can interrupt timers and `Bun.sleepSync`, including
/// instances with no open handles. Each step first dequeues handled signals (a selected default
/// action unwinds inside `dequeue`), keeping them in `deferred`, then waits at most 25 ms. Without
/// the dequeue a pending handled signal makes every wait return at once and the sleep spins.
pub(crate) fn sleep_with(
    duration: std::time::Duration,
    deferred: &mut DeferredSignals,
    mut dequeue: impl FnMut() -> i32,
    mut idle: impl FnMut(i32),
) {
    let started = std::time::Instant::now();
    while started.elapsed() < duration {
        drain_signals(deferred, &mut dequeue);
        let left = duration.saturating_sub(started.elapsed());
        idle(left.as_millis().clamp(1, 25) as i32);
    }
}

#[cfg(test)]
mod signal_tests {
    use super::*;

    #[test]
    fn bun_child_and_signal_slots_are_gone_and_processes_use_runtime_proc_imports() {
        assert_eq!(Slot::LocalAddr as usize, 13);
        assert_eq!(Slot::LookupStart as usize, 14);
        assert_eq!(Slot::LookupHead as usize, 15);
        assert_eq!(SLOT_NAMES[13], "local_addr");
        assert_eq!(SLOT_NAMES[14], "lookup_start");
        assert_eq!(SLOT_NAMES[15], "lookup_head");
        assert_eq!(SLOT_NAMES[16], "listen_path");
        assert_eq!(SLOT_NAMES[17], "connect_path");
        assert_eq!(SLOT_COUNT, 18);
        assert!(
            SLOT_NAMES
                .iter()
                .all(|name| !name.starts_with("child_") && *name != "spawn" && *name != "signal")
        );
        // Off wasm32 the imports do not exist, so every call reports UNSUPPORTED.
        const { assert!(!PROCESS_ABI) };
        assert_eq!(proc_spawn(b"{}"), UNSUPPORTED);
        assert_eq!(proc_pipe(), Err(UNSUPPORTED));
        assert_eq!(proc_poll(&[], 0), Err(UNSUPPORTED));
        assert_eq!(signal(0, 4), UNSUPPORTED);
    }

    #[test]
    fn idle_without_the_process_abi_still_waits_the_requested_time() {
        let started = std::time::Instant::now();
        idle(20);
        assert!(started.elapsed() >= std::time::Duration::from_millis(20));
    }

    #[test]
    fn a_handled_signal_during_sleep_is_deferred_not_spun_on_or_lost() {
        let mut deferred = DeferredSignals::default();
        let mut queue = vec![15, 2];
        let mut idles = 0;
        let mut dequeues = 0;
        let started = std::time::Instant::now();
        sleep_with(
            std::time::Duration::from_millis(60),
            &mut deferred,
            || {
                dequeues += 1;
                if queue.is_empty() { 0 } else { queue.remove(0) }
            },
            |ms| {
                idles += 1;
                assert!((1..=25).contains(&ms));
                // The service has no pending signal left, so waiting really blocks.
                std::thread::sleep(std::time::Duration::from_millis(ms as u64));
            },
        );
        assert!(started.elapsed() >= std::time::Duration::from_millis(60));
        // Bounded: one wait per slice, not one per spin.
        assert!(idles <= 8, "{idles} waits");
        assert_eq!(dequeues, idles + 2);
        // Nothing was dropped; delivery order matches the service's lowest-first dequeue.
        assert_eq!(deferred.take(), 2);
        assert_eq!(deferred.take(), 15);
        assert_eq!(deferred.take(), 0);
    }

    #[test]
    fn a_repeat_of_a_parked_signal_coalesces_and_fatal_beats_parked_callbacks() {
        let mut deferred = DeferredSignals::default();
        deferred.defer(10);
        // The service saw SIGUSR1 again plus SIGTERM while the first copy was parked.
        let mut service = vec![10, 15];
        let mut next = || {
            next_signal(&mut deferred, || {
                if service.is_empty() {
                    0
                } else {
                    service.remove(0)
                }
            })
        };
        assert_eq!(next(), 10);
        assert_eq!(next(), 15);
        assert_eq!(next(), 0);
        // A parked callback must not run before a selected fatal outcome unwinds.
        let mut deferred = DeferredSignals::default();
        deferred.defer(10);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            next_signal(&mut deferred, || panic!("signal death"))
        }));
        assert!(result.is_err());
    }

    #[test]
    fn a_sender_that_republishes_forever_cannot_starve_delivery_or_the_sleep_deadline() {
        let mut deferred = DeferredSignals::default();
        let mut calls = 0;
        // Every dequeue succeeds and the service immediately holds another one.
        let signal = next_signal(&mut deferred, || {
            calls += 1;
            10
        });
        assert_eq!(signal, 10);
        assert_eq!(calls, 64);
        let mut calls = 0;
        let started = std::time::Instant::now();
        sleep_with(
            std::time::Duration::from_millis(40),
            &mut deferred,
            || {
                calls += 1;
                12
            },
            |ms| std::thread::sleep(std::time::Duration::from_millis(ms as u64)),
        );
        assert!(started.elapsed() >= std::time::Duration::from_millis(40));
        assert!(started.elapsed() < std::time::Duration::from_millis(400));
        assert!(calls % 64 == 0 && calls >= 64);
        assert_eq!(deferred.take(), 12);
    }

    #[test]
    fn a_selected_default_action_unwinds_out_of_sleep() {
        let mut deferred = DeferredSignals::default();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sleep_with(
                std::time::Duration::from_secs(10),
                &mut deferred,
                || panic!("signal death"),
                |_| unreachable!(),
            );
        }));
        assert!(result.is_err());
    }

    #[test]
    fn deferred_signals_coalesce_and_can_be_withdrawn() {
        let mut deferred = DeferredSignals::default();
        for signal in [15, 15, 0, 65, -1, 2] {
            deferred.defer(signal);
        }
        assert!(deferred.withdraw(15));
        assert!(!deferred.withdraw(15));
        assert!(!deferred.withdraw(99));
        assert_eq!(deferred.take(), 2);
        assert_eq!(deferred.take(), 0);
    }
}
