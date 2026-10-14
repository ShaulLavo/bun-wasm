//! The `bun_wasm` host ABI (docs/host-abi.md): optional networking functions
//! a host installs into the function table before `_start`.
//!
//! The guest exports `bun_wasm_host_slots`, the address of [`HostSlots`].
//! A host appends its functions to `__indirect_function_table` and writes
//! their table indices into the slots; 0 means "not provided". Under plain
//! `wasmtime run` every slot stays 0 and network APIs report "unsupported".

use std::ptr::{addr_of, addr_of_mut, read_volatile};

pub const ABI_VERSION: u32 = 1;
pub const SLOT_COUNT: usize = 12;

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
}

pub const SLOT_NAMES: [&str; SLOT_COUNT] = [
    "poll", "fetch", "fetch_head", "read", "write", "close", "listen", "local_port", "accept", "connect",
    "error", "peer_addr",
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

/// Table index installed in a slot, if any. Read volatile: the host writes
/// the slots from outside the program, which the optimizer can't see.
fn slot(slot: Slot) -> Option<usize> {
    // SAFETY: plain read of a static only the host writes, before `_start`.
    let index = unsafe { read_volatile(addr_of!(HOST_SLOTS.slots[slot as usize])) };
    (index != 0).then_some(index as usize)
}

pub fn provided(slot_number: usize) -> bool {
    slot_number < SLOT_COUNT
        && unsafe { read_volatile(addr_of!(HOST_SLOTS.slots[slot_number])) } != 0
}

type F1 = extern "C" fn(i32) -> i32;
type F3 = extern "C" fn(i32, i32, i32) -> i32;
type F4 = extern "C" fn(i32, i32, i32, i32) -> i32;

// On wasm32 a function pointer is a table index, so a slot's index can be
// called as a function of the documented signature.
macro_rules! host_fn {
    ($slot:expr, $ty:ty) => {{
        match slot($slot) {
            // SAFETY: the host installed a function with this signature
            // (docs/host-abi.md); a mismatch traps in call_indirect.
            Some(index) => Some(unsafe { std::mem::transmute::<usize, $ty>(index) }),
            None => None,
        }
    }};
}

fn ptr(bytes: &[u8]) -> i32 {
    bytes.as_ptr() as usize as i32
}

pub fn poll(timeout_ms: i32) -> i32 {
    host_fn!(Slot::Poll, F1).map_or(UNSUPPORTED, |f| f(timeout_ms))
}

pub fn fetch(meta: &[u8], body: &[u8]) -> i32 {
    host_fn!(Slot::Fetch, F4).map_or(UNSUPPORTED, |f| f(ptr(meta), meta.len() as i32, ptr(body), body.len() as i32))
}

/// Calls a `(handle, buf, cap) -> len` function, growing the buffer when the
/// host reports a longer result. Returns the bytes or the negative code.
fn read_sized(slot_id: Slot, handle: i32) -> Result<Vec<u8>, i32> {
    let f = host_fn!(slot_id, F3).ok_or(UNSUPPORTED)?;
    let mut buf = vec![0u8; 1024];
    loop {
        let n = f(handle, ptr(&buf), buf.len() as i32);
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
    let f = host_fn!(Slot::Read, F3).ok_or(UNSUPPORTED)?;
    let mut buf = vec![0u8; cap];
    let n = f(handle, ptr(&buf), cap as i32);
    if n < 0 {
        return Err(n);
    }
    buf.truncate(n as usize);
    Ok(buf)
}

pub fn write(handle: i32, data: &[u8]) -> i32 {
    host_fn!(Slot::Write, F3).map_or(UNSUPPORTED, |f| f(handle, ptr(data), data.len() as i32))
}

pub fn close(handle: i32) -> i32 {
    host_fn!(Slot::Close, F1).map_or(UNSUPPORTED, |f| f(handle))
}

pub fn listen(host: &str, port: i32) -> i32 {
    host_fn!(Slot::Listen, F3).map_or(UNSUPPORTED, |f| f(ptr(host.as_bytes()), host.len() as i32, port))
}

pub fn local_port(handle: i32) -> i32 {
    host_fn!(Slot::LocalPort, F1).map_or(UNSUPPORTED, |f| f(handle))
}

pub fn accept(listener: i32) -> i32 {
    host_fn!(Slot::Accept, F1).map_or(UNSUPPORTED, |f| f(listener))
}

pub fn connect(host: &str, port: i32) -> i32 {
    host_fn!(Slot::Connect, F3).map_or(UNSUPPORTED, |f| f(ptr(host.as_bytes()), host.len() as i32, port))
}
