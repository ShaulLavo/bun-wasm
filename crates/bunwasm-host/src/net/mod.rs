//! The host side of the `bun_wasm` ABI (docs/host-abi.md): a table of fetch
//! requests, listeners and TCP connections.
//!
//! Threading model: every guest-facing call runs on the guest's thread and
//! never blocks (except `poll`). Blocking network work runs on background
//! threads that update the handle's shared state and then call
//! [`Notify::bump`], which increments a generation counter and wakes `poll`.

mod error;
mod fetch;
mod resolver;
mod tcp;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub use error::ErrorInfo;

pub const ERROR: i32 = -1;
pub const AGAIN: i32 = -2;
pub const BADF: i32 = -3;

/// Wakes `poll` when any handle changes state.
pub struct Notify {
    generation: Mutex<u64>,
    changed: Condvar,
}

impl Notify {
    fn new() -> Arc<Self> {
        Arc::new(Notify {
            generation: Mutex::new(0),
            changed: Condvar::new(),
        })
    }

    /// Called by background threads after they changed a handle's state.
    pub fn bump(&self) {
        *self.generation.lock().unwrap() += 1;
        self.changed.notify_all();
    }

    /// The change counter. Read it before checking readiness, so a change made during the
    /// check still ends the following [`Notify::wait_past`].
    pub fn generation(&self) -> u64 {
        *self.generation.lock().unwrap()
    }

    /// Waits until something bumps the counter past `seen`, or `timeout` passes.
    pub fn wait_past(&self, seen: u64, timeout: Duration) {
        let generation = self.generation.lock().unwrap();
        drop(
            self.changed
                .wait_timeout_while(generation, timeout, |now| *now == seen)
                .unwrap(),
        );
    }
}

impl std::task::Wake for Notify {
    fn wake(self: Arc<Self>) {
        self.bump();
    }
}

/// Bytes received from the network, waiting for the guest's `read`.
#[derive(Default)]
pub struct ByteQueue(VecDeque<u8>);

impl ByteQueue {
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.0.extend(bytes);
    }

    /// Moves up to `buf.len()` bytes into `buf`; returns how many.
    pub fn pop_into(&mut self, buf: &mut [u8]) -> usize {
        let n = buf.len().min(self.0.len());
        let (front, back) = self.0.as_slices();
        let from_front = n.min(front.len());
        buf[..from_front].copy_from_slice(&front[..from_front]);
        buf[from_front..n].copy_from_slice(&back[..n - from_front]);
        self.0.drain(..n);
        n
    }
}

/// Readers stop pulling from the network while this much is unread.
pub const READ_HIGH_WATER: usize = 1 << 20;

enum Handle {
    Fetch(fetch::Fetch),
    Listener(tcp::Listener),
    Conn(tcp::Conn),
    Lookup(resolver::Lookup),
}

pub struct Net {
    notify: Arc<Notify>,
    /// Generation observed when `poll` last returned.
    seen: u64,
    next_handle: i32,
    handles: HashMap<i32, Handle>,
    /// The last error that has no handle (`error(0, …)`).
    last_error: Option<ErrorInfo>,
    clients: Arc<fetch::Clients>,
    /// Closed connections still flushing writes; waited for at exit.
    flushing: Vec<tcp::Conn>,
}

/// Result of a call that produces bytes for the guest: written with the
/// "return the needed length if it doesn't fit" protocol.
pub enum Output {
    Code(i32),
    Bytes(Vec<u8>),
}

impl Net {
    pub fn new() -> Self {
        Net {
            notify: Notify::new(),
            seen: 0,
            next_handle: 1,
            handles: HashMap::new(),
            last_error: None,
            clients: Arc::default(),
            flushing: Vec::new(),
        }
    }

    pub fn notify(&self) -> Arc<Notify> {
        self.notify.clone()
    }

    fn require_handle(&self) -> Result<(), ErrorInfo> {
        if self.next_handle >= crate::process::FIRST_HANDLE {
            return Err(ErrorInfo::new(
                "Error",
                "bun-wasm network handle space exhausted",
                Some("EAGAIN"),
            ));
        }
        Ok(())
    }

    fn insert(&mut self, handle: Handle) -> i32 {
        // Callers preflight before starting I/O or consuming an accepted socket.
        debug_assert!(self.next_handle < crate::process::FIRST_HANDLE);
        let id = self.next_handle;
        self.next_handle += 1;
        self.handles.insert(id, handle);
        id
    }

    pub fn fail(&mut self, error: ErrorInfo) -> i32 {
        self.last_error = Some(error);
        ERROR
    }

    pub fn poll(&mut self, timeout_ms: i32) -> i32 {
        let deadline =
            (timeout_ms >= 0).then(|| Instant::now() + Duration::from_millis(timeout_ms as u64));
        let mut generation = self.notify.generation.lock().unwrap();
        while *generation == self.seen {
            match deadline {
                None => generation = self.notify.changed.wait(generation).unwrap(),
                Some(deadline) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return 0;
                    }
                    generation = self
                        .notify
                        .changed
                        .wait_timeout(generation, deadline - now)
                        .unwrap()
                        .0;
                }
            }
        }
        self.seen = *generation;
        1
    }

    pub fn fetch(&mut self, meta: &[u8], body: &[u8]) -> i32 {
        if let Err(error) = self.require_handle() {
            return self.fail(error);
        }
        match fetch::Fetch::start(&self.clients, meta, body, self.notify.clone()) {
            Ok(request) => self.insert(Handle::Fetch(request)),
            Err(error) => self.fail(error),
        }
    }

    pub fn fetch_head(&mut self, handle: i32) -> Output {
        match self.handles.get(&handle) {
            Some(Handle::Fetch(request)) => request.head(),
            _ => Output::Code(BADF),
        }
    }

    pub fn lookup(&mut self, hostname: &str, family: i32, hints: i32) -> i32 {
        if let Err(error) = self.require_handle() {
            return self.fail(error);
        }
        match resolver::Lookup::start(hostname, family, hints, self.notify.clone()) {
            Ok(lookup) => self.insert(Handle::Lookup(lookup)),
            Err(error) => self.fail(error),
        }
    }

    pub fn lookup_head(&mut self, handle: i32) -> Output {
        match self.handles.get(&handle) {
            Some(Handle::Lookup(lookup)) => lookup.head(),
            _ => Output::Code(BADF),
        }
    }

    pub fn read(&mut self, handle: i32, buf: &mut [u8]) -> i32 {
        match self.handles.get(&handle) {
            Some(Handle::Fetch(request)) => request.read(buf),
            Some(Handle::Conn(conn)) => conn.read(buf),
            _ => BADF,
        }
    }

    pub fn write(&mut self, handle: i32, data: &[u8]) -> i32 {
        match self.handles.get(&handle) {
            Some(Handle::Conn(conn)) => conn.write(data),
            _ => BADF,
        }
    }

    pub fn close(&mut self, handle: i32) -> i32 {
        match self.handles.remove(&handle) {
            Some(Handle::Fetch(request)) => request.abort(),
            Some(Handle::Lookup(_)) => {}
            Some(Handle::Listener(listener)) => listener.close(),
            Some(Handle::Conn(conn)) => {
                conn.close();
                self.flushing.retain(|c| c.is_flushing());
                self.flushing.push(conn);
            }
            None => return BADF,
        }
        0
    }

    pub fn listen(&mut self, host: &str, port: i32) -> i32 {
        if let Err(error) = self.require_handle() {
            return self.fail(error);
        }
        match tcp::Listener::bind(host, port, self.notify.clone()) {
            Ok(listener) => self.insert(Handle::Listener(listener)),
            Err(error) => self.fail(error),
        }
    }

    pub fn local_port(&mut self, handle: i32) -> i32 {
        match self.handles.get(&handle) {
            Some(Handle::Listener(listener)) => listener.port() as i32,
            Some(Handle::Conn(conn)) => conn.local_port().map_or(AGAIN, i32::from),
            _ => BADF,
        }
    }

    pub fn accept(&mut self, handle: i32) -> i32 {
        let listener = match self.handles.get(&handle) {
            Some(Handle::Listener(listener)) => listener,
            _ => return BADF,
        };
        if let Err(error) = self.require_handle() {
            return self.fail(error);
        }
        match listener.accept() {
            Some(conn) => self.insert(Handle::Conn(conn)),
            None => AGAIN,
        }
    }

    pub fn shutdown(&mut self, handle: i32) -> i32 {
        match self.handles.get(&handle) {
            Some(Handle::Conn(conn)) => {
                conn.shutdown();
                0
            }
            _ => BADF,
        }
    }

    pub fn local_addr(&mut self, handle: i32) -> Output {
        let address = match self.handles.get(&handle) {
            Some(Handle::Conn(conn)) => conn.local_addr(),
            Some(Handle::Listener(listener)) => Some(listener.local_addr()),
            _ => return Output::Code(BADF),
        };
        address.map_or(Output::Code(AGAIN), |addr| {
            Output::Bytes(tcp::addr_json(addr))
        })
    }

    pub fn connect(&mut self, host: &str, port: i32) -> i32 {
        if !(0..=65535).contains(&port) {
            return self.fail(ErrorInfo::new(
                "RangeError",
                format!("Port should be >= 0 and < 65536. Received {port}."),
                Some("ERR_SOCKET_BAD_PORT"),
            ));
        }
        if let Err(error) = self.require_handle() {
            return self.fail(error);
        }
        let conn = tcp::Conn::connect(host.to_string(), port as u16, self.notify.clone());
        self.insert(Handle::Conn(conn))
    }

    pub fn error(&mut self, handle: i32) -> Output {
        let error = match (handle, self.handles.get(&handle)) {
            (0, _) => self.last_error.clone(),
            (_, Some(Handle::Fetch(request))) => request.error(),
            (_, Some(Handle::Conn(conn))) => conn.error(),
            (_, Some(Handle::Lookup(lookup))) => lookup.error(),
            (_, Some(Handle::Listener(_))) => None,
            (_, None) => return Output::Code(BADF),
        };
        let error = error.unwrap_or_else(|| {
            ErrorInfo::new(
                "Error",
                format!("network operation failed for handle {handle}"),
                Some("ERR_NETWORK"),
            )
        });
        Output::Bytes(error.to_json())
    }

    pub fn peer_addr(&mut self, handle: i32) -> Output {
        match self.handles.get(&handle) {
            Some(Handle::Conn(conn)) => match conn.peer_addr() {
                Some(addr) => Output::Bytes(tcp::addr_json(addr)),
                None => Output::Code(AGAIN),
            },
            _ => Output::Code(BADF),
        }
    }

    /// At exit: give closed connections a moment to send what the guest
    /// already wrote (e.g. a response followed by `process.exit()`).
    pub fn flush_closed(&mut self, limit: Duration) {
        let deadline = Instant::now() + limit;
        for conn in self.flushing.drain(..) {
            conn.wait_flushed(deadline);
        }
    }
}

impl Drop for Net {
    fn drop(&mut self) {
        for (_, handle) in self.handles.drain() {
            match handle {
                Handle::Fetch(request) => request.abort(),
                Handle::Listener(listener) => listener.close(),
                Handle::Conn(conn) => conn.close(),
                Handle::Lookup(_) => {}
            }
        }
    }
}
