//! The `bun_wasm` host ABI (docs/host-abi.md): optional networking functions
//! a host installs into the function table before `_start`.
//!
//! The guest exports `bun_wasm_host_slots`, the address of [`HostSlots`].
//! A host appends its functions to `__indirect_function_table` and writes
//! their table indices into the slots; 0 means "not provided". Under plain
//! `wasmtime run` every slot stays 0 and network APIs report "unsupported".

use std::ptr::{addr_of, addr_of_mut, read_volatile};

pub const ABI_VERSION: u32 = 1;
pub const SLOT_COUNT: usize = 14;

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
}

pub const SLOT_NAMES: [&str; SLOT_COUNT] = [
    "poll", "fetch", "fetch_head", "read", "write", "close", "listen", "local_port", "accept", "connect",
    "error", "peer_addr", "shutdown", "local_addr",
];

#[repr(C)]
pub struct HostSlots {
    version: u32,
    count: u32,
    slots: [u32; SLOT_COUNT],
}

static mut HOST_SLOTS: HostSlots = HostSlots { version: ABI_VERSION, count: SLOT_COUNT as u32, slots: [0; SLOT_COUNT] };

/// Exported (see crates/bunwasm-cli/build.rs) for hosts to fill in.
#[unsafe(no_mangle)]
pub extern "C" fn bun_wasm_host_slots() -> *mut HostSlots {
    addr_of_mut!(HOST_SLOTS)
}

pub fn provided(slot_number: usize) -> bool {
    slot_number < SLOT_COUNT
        && unsafe { read_volatile(addr_of!(HOST_SLOTS.slots[slot_number])) } != 0
}

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
    fn wasi_sock_send(fd: i32, si_data: i32, si_data_len: i32, si_flags: i32, so_datalen: i32) -> i32;
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
            let errno = unsafe { wasi_sock_send(HOST_CALL_FD, packet.as_ptr() as i32, 5, 0, addr_of_mut!(result) as i32) };
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
            Slot::Poll | Slot::Close | Slot::LocalPort | Slot::Accept | Slot::Shutdown => std::mem::transmute::<usize, F1>(index as usize)(args[0]),
            Slot::Fetch => std::mem::transmute::<usize, F4>(index as usize)(args[0], args[1], args[2], args[3]),
            Slot::FetchHead | Slot::Read | Slot::Write | Slot::Listen | Slot::Connect | Slot::Error | Slot::PeerAddr | Slot::LocalAddr => std::mem::transmute::<usize, F3>(index as usize)(args[0], args[1], args[2]),
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
    call(Slot::Fetch, [ptr(meta), meta.len() as i32, ptr(body), body.len() as i32]).unwrap_or(UNSUPPORTED)
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
    call(Slot::Listen, [ptr(host.as_bytes()), host.len() as i32, port, 0]).unwrap_or(UNSUPPORTED)
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
    call(Slot::Connect, [ptr(host.as_bytes()), host.len() as i32, port, 0]).unwrap_or(UNSUPPORTED)
}

/// The `runtime_proc` process ABI (docs/host-abi.md, "Process imports"). These are real wasm
/// imports, not optional slots: a host that runs the guest provides the namespace. Results are
/// `>= 0` or a negative WASI errno.
#[cfg(target_arch = "wasm32")]
mod runtime_proc {
    #[link(wasm_import_module = "runtime_proc")]
    unsafe extern "C" {
        pub fn spawn(desc_ptr: i32, desc_len: i32) -> i32;
        pub fn job_of(pid: i32) -> i32;
        pub fn pipe(out_ptr: i32) -> i32;
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
    pub unsafe fn spawn(_: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn job_of(_: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn pipe(_: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn read(_: i32, _: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn write(_: i32, _: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn wait(_: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn wait_job(_: i32, _: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn kill(_: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn kill_job(_: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn poll(_: i32, _: i32, _: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn signal(_: i32, _: i32) -> i32 { UNSUPPORTED }
    pub unsafe fn fd_close(_: i32) -> i32 { -UNSUPPORTED }
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
    if result < 0 { Err(result) } else { Ok((ends[0], ends[1])) }
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

/// `(kind, code)` of a finished child: kind 0 exited, 1 signaled. `Err(-EAGAIN)` while running.
pub fn proc_wait(pid: i32) -> Result<(u32, i32), i32> {
    let mut status = [0i32; 2];
    let result = proc_call!(runtime_proc::wait(pid, ptr_mut(&mut status)));
    if result < 0 { Err(result) } else { Ok((status[0] as u32, status[1])) }
}

pub fn proc_wait_job(job: i32, flags: i32) -> Result<i32, i32> {
    let mut status = [0i32; 1];
    let result = proc_call!(runtime_proc::wait_job(job, flags, ptr_mut(&mut status)));
    if result < 0 { Err(result) } else { Ok(status[0]) }
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
    let ready = proc_call!(runtime_proc::poll(ptr(subscriptions), count as i32, timeout_ms, ptr_mut(&mut events)));
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

/// Sleep through the host when present so child cancellation can interrupt timers
/// and Bun.sleepSync, including instances with no open network handles.
pub fn sleep(duration: std::time::Duration) {
    if !provided(Slot::Poll as usize) {
        std::thread::sleep(duration);
        return;
    }
    let started = std::time::Instant::now();
    while started.elapsed() < duration {
        let left = duration.saturating_sub(started.elapsed());
        poll(left.as_millis().clamp(1, 25) as i32);
    }
}

#[cfg(test)]
mod signal_tests {
    use super::*;

    #[test]
    fn bun_child_and_signal_slots_are_gone_and_processes_use_runtime_proc_imports() {
        assert_eq!(Slot::LocalAddr as usize, 13);
        assert_eq!(SLOT_NAMES[13], "local_addr");
        assert_eq!(SLOT_COUNT, 14);
        assert!(SLOT_NAMES.iter().all(|name| !name.starts_with("child_") && *name != "spawn" && *name != "signal"));
        // Off wasm32 the imports do not exist, so every call reports UNSUPPORTED.
        assert!(!PROCESS_ABI);
        assert_eq!(proc_spawn(b"{}"), UNSUPPORTED);
        assert_eq!(proc_pipe(), Err(UNSUPPORTED));
        assert_eq!(proc_poll(&[], 0), Err(UNSUPPORTED));
        assert_eq!(signal(0, 4), UNSUPPORTED);
    }
}
