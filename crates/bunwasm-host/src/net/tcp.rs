//! TCP listeners and connections for `listen` / `accept` / `connect` /
//! `read` / `write` / `close`.
//!
//! A listener has one accept thread. A connection has a reader thread that
//! fills its receive queue and a writer thread that drains its send queue
//! (for `connect`, the writer thread first dials). The guest only ever
//! touches the queues, so none of its calls block.

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use super::error::{ErrorInfo, socket_error};
use super::{AGAIN, ByteQueue, ERROR, Notify, READ_HIGH_WATER};

/// `write` returns AGAIN once this much is queued and unsent.
const WRITE_HIGH_WATER: usize = 1 << 20;
/// A single `write` may always queue this much when there's room at all.
const MIN_WRITE_ACCEPT: usize = 64 * 1024;
/// After the guest closes a connection, how long we keep reading (and
/// discarding) so the kernel doesn't reset the connection on unread data.
const LINGER: Duration = Duration::from_secs(5);
const READ_TICK: Duration = Duration::from_millis(500);

fn spawn(name: &str, f: impl FnOnce() + Send + 'static) -> io::Result<JoinHandle<()>> {
    thread::Builder::new().name(name.into()).stack_size(256 * 1024).spawn(f)
}

/// Addresses to bind for a `listen` host.
fn bind_addrs(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host {
        "" => Ok(vec![SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port)]),
        "localhost" => Ok(vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)]),
        _ => Ok((host, port).to_socket_addrs()?.collect()),
    }
}

pub fn addr_json(addr: SocketAddr) -> Vec<u8> {
    let family = if addr.is_ipv4() { "IPv4" } else { "IPv6" };
    serde_json::to_vec(&serde_json::json!({ "address": addr.ip().to_string(), "port": addr.port(), "family": family }))
        .expect("address serializes")
}

pub struct Listener {
    shared: Arc<ListenerShared>,
    port: u16,
    local: SocketAddr,
    /// Where to connect to wake the accept thread when closing.
    wake: SocketAddr,
    thread: Option<JoinHandle<()>>,
}

struct ListenerShared {
    pending: Mutex<VecDeque<Conn>>,
    closed: AtomicBool,
}

impl Listener {
    pub fn bind(host: &str, port: i32, notify: Arc<Notify>) -> Result<Listener, ErrorInfo> {
        let Ok(port) = u16::try_from(port) else {
            return Err(ErrorInfo::new(
                "RangeError",
                format!("Port should be >= 0 and < 65536. Received {port}."),
                Some("ERR_SOCKET_BAD_PORT"),
            ));
        };
        let target = format!("{host}:{port}");
        let addrs = bind_addrs(host, port).map_err(|e| socket_error("listen", &e, &target))?;
        let mut last_error = io::Error::new(io::ErrorKind::AddrNotAvailable, "no addresses");
        let mut bound = None;
        for addr in addrs {
            match TcpListener::bind(addr) {
                Ok(listener) => {
                    bound = Some(listener);
                    break;
                }
                Err(e) => last_error = e,
            }
        }
        let Some(listener) = bound else {
            if last_error.kind() == io::ErrorKind::AddrInUse {
                return Err(ErrorInfo::new(
                    "Error",
                    format!("Failed to start server. Is port {port} in use?"),
                    Some("EADDRINUSE"),
                )
                .with_syscall("listen"));
            }
            return Err(socket_error("listen", &last_error, &target));
        };
        let local = listener.local_addr().map_err(|e| socket_error("listen", &e, &target))?;
        let wake = match local.ip() {
            IpAddr::V4(ip) if ip.is_unspecified() => SocketAddr::new(Ipv4Addr::LOCALHOST.into(), local.port()),
            IpAddr::V6(ip) if ip.is_unspecified() => SocketAddr::new(Ipv6Addr::LOCALHOST.into(), local.port()),
            _ => local,
        };
        let shared = Arc::new(ListenerShared { pending: Mutex::new(VecDeque::new()), closed: AtomicBool::new(false) });
        let accept_shared = shared.clone();
        let thread = spawn("bun-wasm-accept", move || accept_loop(listener, accept_shared, notify))
            .map_err(|e| socket_error("listen", &e, &target))?;
        Ok(Listener { shared, port: local.port(), local, wake, thread: Some(thread) })
    }

    pub fn local_addr(&self) -> SocketAddr { self.local }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn accept(&self) -> Option<Conn> {
        self.shared.pending.lock().unwrap().pop_front()
    }

    /// Stops accepting and frees the port before returning, so the guest
    /// can listen on it again right away.
    pub fn close(mut self) {
        self.shared.closed.store(true, Ordering::SeqCst);
        // A blocked accept() can't be interrupted portably; connecting to
        // ourselves makes it return so the thread sees `closed`.
        let woke = TcpStream::connect_timeout(&self.wake, Duration::from_secs(1)).is_ok();
        if let Some(thread) = self.thread.take().filter(|_| woke) {
            let _ = thread.join();
        }
        for conn in self.shared.pending.lock().unwrap().drain(..) {
            conn.close();
        }
    }
}

fn accept_loop(listener: TcpListener, shared: Arc<ListenerShared>, notify: Arc<Notify>) {
    loop {
        let accepted = listener.accept();
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
        match accepted {
            Ok((stream, _)) => {
                let conn = Conn::accepted(stream, notify.clone());
                shared.pending.lock().unwrap().push_back(conn);
                notify.bump();
            }
            // Out of file descriptors and the like: back off and retry.
            Err(_) => thread::sleep(Duration::from_millis(10)),
        }
    }
}

#[derive(PartialEq)]
enum Phase {
    Connecting,
    Open,
    Failed,
}

struct ConnState {
    phase: Phase,
    local: Option<SocketAddr>,
    peer: Option<SocketAddr>,
    received: ByteQueue,
    read_eof: bool,
    read_failed: bool,
    send: ByteQueue,
    /// The guest got AGAIN from `write`; tell it (via poll) when there's room.
    want_writable: bool,
    /// The guest closed the handle: flush, then shut down.
    closed: bool,
    write_shutdown: bool,
    /// The writer thread finished (flushed or failed).
    done: bool,
    error: Option<ErrorInfo>,
}

struct ConnShared {
    state: Mutex<ConnState>,
    /// Wakes the reader/writer threads (data to send, room to receive, close).
    wake: Condvar,
    notify: Arc<Notify>,
}

impl ConnShared {
    fn update(&self, f: impl FnOnce(&mut ConnState)) {
        f(&mut self.state.lock().unwrap());
        self.wake.notify_all();
        self.notify.bump();
    }
}

#[derive(Clone)]
pub struct Conn {
    shared: Arc<ConnShared>,
}

impl Conn {
    fn new(phase: Phase, notify: Arc<Notify>) -> Conn {
        let state = ConnState {
            phase,
            local: None,
            peer: None,
            received: ByteQueue::default(),
            read_eof: false,
            read_failed: false,
            send: ByteQueue::default(),
            want_writable: false,
            closed: false,
            write_shutdown: false,
            done: false,
            error: None,
        };
        Conn { shared: Arc::new(ConnShared { state: Mutex::new(state), wake: Condvar::new(), notify }) }
    }

    fn accepted(stream: TcpStream, notify: Arc<Notify>) -> Conn {
        let conn = Conn::new(Phase::Open, notify);
        // Known now, so `peer_addr` works right after `accept`.
        {
            let mut state = conn.shared.state.lock().unwrap();
            state.local = stream.local_addr().ok();
            state.peer = stream.peer_addr().ok();
        }
        let shared = conn.shared.clone();
        if let Err(e) = spawn("bun-wasm-conn", move || run_open(shared, stream)) {
            conn.shared.update(|s| fail(s, socket_error("accept", &e, "")));
        }
        conn
    }

    pub fn connect(host: String, port: u16, notify: Arc<Notify>) -> Conn {
        let conn = Conn::new(Phase::Connecting, notify);
        let shared = conn.shared.clone();
        if let Err(e) = spawn("bun-wasm-conn", move || dial(shared, &host, port)) {
            conn.shared.update(|s| fail(s, socket_error("connect", &e, "")));
        }
        conn
    }

    pub fn read(&self, buf: &mut [u8]) -> i32 {
        let mut state = self.shared.state.lock().unwrap();
        if !state.received.is_empty() {
            let n = state.received.pop_into(buf);
            drop(state);
            self.shared.wake.notify_all();
            return n as i32;
        }
        match state.phase {
            Phase::Failed => ERROR,
            _ if state.read_failed => ERROR,
            _ if state.read_eof => 0,
            _ => AGAIN,
        }
    }

    pub fn write(&self, data: &[u8]) -> i32 {
        let mut state = self.shared.state.lock().unwrap();
        match state.phase {
            Phase::Failed => return ERROR,
            Phase::Connecting => {
                state.want_writable = true;
                return AGAIN;
            }
            Phase::Open => {}
        }
        if state.write_shutdown || state.closed {
            return ERROR;
        }
        if data.is_empty() {
            return 0;
        }
        let queued = state.send.len();
        if queued >= WRITE_HIGH_WATER {
            state.want_writable = true;
            return AGAIN;
        }
        let n = data.len().min((WRITE_HIGH_WATER - queued).max(MIN_WRITE_ACCEPT));
        state.send.push(&data[..n]);
        drop(state);
        self.shared.wake.notify_all();
        n as i32
    }

    pub fn local_addr(&self) -> Option<SocketAddr> { self.shared.state.lock().unwrap().local }

    pub fn shutdown(&self) {
        self.shared.state.lock().unwrap().write_shutdown = true;
        self.shared.wake.notify_all();
    }

    pub fn close(&self) {
        self.shared.state.lock().unwrap().closed = true;
        self.shared.wake.notify_all();
    }

    pub fn error(&self) -> Option<ErrorInfo> {
        self.shared.state.lock().unwrap().error.clone()
    }

    pub fn local_port(&self) -> Option<u16> {
        self.shared.state.lock().unwrap().local.map(|a| a.port())
    }

    pub fn peer_addr(&self) -> Option<SocketAddr> {
        self.shared.state.lock().unwrap().peer
    }

    pub fn is_flushing(&self) -> bool {
        !self.shared.state.lock().unwrap().done
    }

    pub fn wait_flushed(&self, deadline: Instant) {
        let mut state = self.shared.state.lock().unwrap();
        while !state.done {
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            state = self.shared.wake.wait_timeout(state, deadline - now).unwrap().0;
        }
    }
}

fn fail(state: &mut ConnState, error: ErrorInfo) {
    state.phase = Phase::Failed;
    state.done = true;
    state.error.get_or_insert(error);
}

/// Connect thread for `connect`: resolve, dial, then serve the connection.
fn dial(shared: Arc<ConnShared>, host: &str, port: u16) {
    let target = format!("{host}:{port}");
    let addrs: Vec<SocketAddr> = match (host.trim_start_matches('[').trim_end_matches(']'), port).to_socket_addrs() {
        Ok(addrs) => addrs.collect(),
        Err(e) => return shared.update(|s| fail(s, socket_error("connect", &e, &target))),
    };
    let mut last = None;
    for addr in addrs {
        match TcpStream::connect(addr) {
            Ok(stream) => return run_open(shared, stream),
            Err(e) => last = Some((e, addr)),
        }
    }
    let error = match last {
        Some((e, addr)) => socket_error("connect", &e, &addr.to_string()),
        None => socket_error("connect", &io::Error::other("failed to lookup address information"), &target),
    };
    shared.update(|s| fail(s, error));
}

/// Runs an established connection: spawns the reader, then acts as the writer.
fn run_open(shared: Arc<ConnShared>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    // Blocking reads wake up periodically so the reader notices a close.
    let _ = stream.set_read_timeout(Some(READ_TICK));
    let (local, peer) = (stream.local_addr().ok(), stream.peer_addr().ok());
    let reader = match stream.try_clone() {
        Ok(reader) => reader,
        Err(e) => return shared.update(|s| fail(s, socket_error("read", &e, ""))),
    };
    let reader_shared = shared.clone();
    if let Err(e) = spawn("bun-wasm-read", move || read_loop(reader_shared, reader)) {
        return shared.update(|s| fail(s, socket_error("read", &e, "")));
    }
    shared.update(|s| {
        s.phase = Phase::Open;
        s.local = local;
        s.peer = peer;
    });
    write_loop(&shared, stream);
}

fn read_loop(shared: Arc<ConnShared>, mut stream: TcpStream) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut closed_at = None;
    loop {
        let closed = {
            let mut state = shared.state.lock().unwrap();
            while state.received.len() >= READ_HIGH_WATER && !state.closed {
                state = shared.wake.wait(state).unwrap();
            }
            state.closed
        };
        if closed {
            let since = *closed_at.get_or_insert_with(Instant::now);
            if since.elapsed() >= LINGER {
                return;
            }
        }
        match stream.read(&mut buf) {
            Ok(0) => return shared.update(|s| s.read_eof = true),
            // After close, read only to drain the socket (see LINGER).
            Ok(_) if closed => {}
            Ok(n) => shared.update(|s| s.received.push(&buf[..n])),
            // The read timeout (see READ_TICK) lets us notice a close.
            Err(e) if matches!(e.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(_) if closed => return,
            Err(e) => {
                let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
                return shared.update(|s| {
                    s.read_failed = true;
                    s.error.get_or_insert(socket_error("read", &e, &peer));
                });
            }
        }
    }
}

fn write_loop(shared: &ConnShared, mut stream: TcpStream) {
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let n = {
            let mut state = shared.state.lock().unwrap();
            while state.send.is_empty() && !state.closed && !state.write_shutdown {
                state = shared.wake.wait(state).unwrap();
            }
            if state.send.is_empty() {
                break; // closed and flushed
            }
            state.send.pop_into(&mut chunk)
        };
        if let Err(e) = stream.write_all(&chunk[..n]) {
            let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
            shared.update(|s| {
                fail(s, socket_error("write", &e, &peer));
                s.send = ByteQueue::default();
            });
            return;
        }
        let mut state = shared.state.lock().unwrap();
        if state.want_writable && state.send.len() < WRITE_HIGH_WATER {
            state.want_writable = false;
            drop(state);
            shared.notify.bump();
        }
    }
    // Graceful close: FIN after the queued data. The reader keeps draining
    // the socket for up to LINGER so unread input doesn't trigger a reset.
    let _ = stream.shutdown(Shutdown::Write);
    shared.update(|s| s.done = true);
}
