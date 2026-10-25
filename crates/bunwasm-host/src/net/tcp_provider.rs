//! Bun address policy and error metadata over opaque Waffle tokens.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::error::{ErrorInfo, socket_error};
use super::waffle_native::{Actor, Socket};
use super::{AGAIN, ERROR};

pub struct Listener {
    actor: Arc<Actor>,
    socket: Socket,
    local: SocketAddr,
}

impl Listener {
    pub fn bind(host: &str, port: i32, actor: Arc<Actor>) -> Result<Self, ErrorInfo> {
        let port = port_number(port)?;
        let target = format!("{host}:{port}");
        let result = bind(&actor, host, port);
        let socket = result.map_err(|error| listen_error(&error, &target, port))?;
        let local = match actor.address(socket, false) {
            Ok(address) => address,
            Err(error) => {
                let _ = actor.close(socket);
                return Err(socket_error("listen", &error, &target));
            }
        };
        Ok(Self {
            actor,
            socket,
            local,
        })
    }

    pub fn port(&self) -> u16 {
        self.local.port()
    }
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    pub fn accept(&self) -> Result<Conn, io::Error> {
        let socket = self.actor.accept(self.socket)?;
        let target = match self.actor.address(socket, true) {
            Ok(address) => address.to_string(),
            Err(error) => {
                let _ = self.actor.close(socket);
                return Err(error);
            }
        };
        Ok(Conn::new(Ok(socket), target, false, self.actor.clone()))
    }

    pub fn close(&self) -> io::Result<()> {
        self.actor.close(self.socket)
    }
}

fn bind(actor: &Actor, host: &str, port: u16) -> io::Result<Socket> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.parse::<Ipv6Addr>().is_ok_and(|ip| ip.is_unspecified()) {
        return actor.listen_default(port);
    }
    let addresses = addresses(host, port)?;
    let mut error = io::ErrorKind::AddrNotAvailable.into();
    for address in addresses {
        match actor.listen(address) {
            Ok(socket) => return Ok(socket),
            Err(failure) => error = failure,
        }
    }
    Err(error)
}

fn addresses(host: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
    #[cfg(test)]
    if let Some(result) = lookup_fixture::take() {
        return result;
    }
    match host {
        "" => Ok(vec![SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), port)]),
        "localhost" => Ok(vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)]),
        _ => (host, port).to_socket_addrs().map(Iterator::collect),
    }
}

pub fn port_number(port: i32) -> Result<u16, ErrorInfo> {
    u16::try_from(port).map_err(|_| {
        ErrorInfo::new(
            "RangeError",
            format!("Port should be >= 0 and < 65536. Received {port}."),
            Some("ERR_SOCKET_BAD_PORT"),
        )
    })
}

fn listen_error(error: &io::Error, target: &str, port: u16) -> ErrorInfo {
    if error.kind() == io::ErrorKind::AddrInUse {
        return ErrorInfo::new(
            "Error",
            format!("Failed to start server. Is port {port} in use?"),
            Some("EADDRINUSE"),
        )
        .with_syscall("listen");
    }
    socket_error("listen", error, target)
}

pub fn addr_json(address: SocketAddr) -> Vec<u8> {
    let family = if address.is_ipv4() { "IPv4" } else { "IPv6" };
    serde_json::to_vec(&serde_json::json!({ "address": address.ip().to_string(), "port": address.port(), "family": family })).expect("address serializes")
}

pub struct Conn {
    actor: Arc<Actor>,
    socket: Result<Socket, ErrorInfo>,
    target: String,
    connected: AtomicBool,
    error: Mutex<Option<ErrorInfo>>,
}

impl Conn {
    fn new(
        socket: Result<Socket, ErrorInfo>,
        target: String,
        outgoing: bool,
        actor: Arc<Actor>,
    ) -> Self {
        Self {
            actor,
            socket,
            target,
            connected: AtomicBool::new(!outgoing),
            error: Mutex::new(None),
        }
    }

    pub fn connect(host: &str, port: u16, actor: Arc<Actor>) -> Self {
        let target = format!("{host}:{port}");
        let socket = addresses(host.trim_start_matches('[').trim_end_matches(']'), port)
            .and_then(|addresses| {
                addresses
                    .first()
                    .copied()
                    .ok_or(io::ErrorKind::AddrNotAvailable.into())
            })
            .and_then(|address| actor.connect(address))
            .map_err(|error| socket_error("connect", &error, &target));
        Self::new(socket, target, true, actor)
    }

    fn code(&self, syscall: &str, result: io::Result<usize>) -> i32 {
        match result {
            Ok(count) => {
                self.connected.store(true, Ordering::Relaxed);
                count as i32
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => AGAIN,
            Err(error) => {
                self.record(syscall, &error);
                ERROR
            }
        }
    }

    fn record(&self, syscall: &str, error: &io::Error) {
        let syscall = if self.connected.load(Ordering::Relaxed) {
            syscall
        } else {
            "connect"
        };
        self.error
            .lock()
            .unwrap()
            .get_or_insert_with(|| socket_error(syscall, error, &self.target));
    }

    pub fn read(&self, buffer: &mut [u8]) -> i32 {
        let Ok(socket) = self.socket else {
            return ERROR;
        };
        let result = self.actor.read(socket, buffer.len()).map(|bytes| {
            buffer[..bytes.len()].copy_from_slice(&bytes);
            bytes.len()
        });
        self.code("read", result)
    }

    pub fn write(&self, bytes: &[u8]) -> i32 {
        let Ok(socket) = self.socket else {
            return ERROR;
        };
        self.code("write", self.actor.write(socket, bytes))
    }

    pub fn shutdown(&self) -> i32 {
        let Ok(socket) = self.socket else {
            return ERROR;
        };
        self.code("shutdown", self.actor.shutdown(socket).map(|()| 0))
    }

    pub fn close(&self) -> io::Result<()> {
        match self.socket {
            Ok(socket) => self.actor.close(socket),
            Err(_) => Ok(()),
        }
    }

    pub fn error(&self) -> Option<ErrorInfo> {
        let socket = match &self.socket {
            Ok(socket) => *socket,
            Err(error) => return Some(error.clone()),
        };
        if let Err(error) = self.actor.check(socket)
            && error.kind() != io::ErrorKind::WouldBlock
        {
            self.record("read", &error);
        }
        self.error.lock().unwrap().clone()
    }

    pub fn local_port(&self) -> Result<u16, i32> {
        self.local_addr().map(|address| address.port())
    }
    pub fn local_addr(&self) -> Result<SocketAddr, i32> {
        self.address(false)
    }
    pub fn peer_addr(&self) -> Result<SocketAddr, i32> {
        self.address(true)
    }

    fn address(&self, peer: bool) -> Result<SocketAddr, i32> {
        let socket = *self.socket.as_ref().map_err(|_| ERROR)?;
        if let Err(error) = self.actor.check(socket) {
            return Err(self.code("getpeername", Err(error)));
        }
        match self.actor.address(socket, peer) {
            Ok(address) => {
                if peer {
                    self.connected.store(true, Ordering::Relaxed);
                }
                Ok(address)
            }
            Err(error) if error.kind() == io::ErrorKind::NotConnected => Err(AGAIN),
            Err(error) => {
                Err(self.code(if peer { "getpeername" } else { "getsockname" }, Err(error)))
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod lookup_fixture {
    use super::*;
    use std::cell::RefCell;

    type Lookup = Box<dyn FnOnce() -> io::Result<Vec<SocketAddr>>>;
    thread_local! { static LOOKUP: RefCell<Option<Lookup>> = const { RefCell::new(None) }; }

    pub fn install(lookup: impl FnOnce() -> io::Result<Vec<SocketAddr>> + 'static) {
        LOOKUP.with(|slot| {
            assert!(slot.borrow().is_none());
            *slot.borrow_mut() = Some(Box::new(lookup));
        });
    }

    pub(super) fn take() -> Option<io::Result<Vec<SocketAddr>>> {
        let lookup = LOOKUP.with(|slot| slot.borrow_mut().take());
        lookup.map(|lookup| lookup())
    }
}
