//! Unix Wasmtime owner for Waffle's compiled network module.
//! The actor owns Waffle resources; callers retain only facade policy.

use std::collections::BTreeMap;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use waffle_tcp::abi::{self, ADDRESS_SIZE};
use waffle_tcp::native::{ControlWake, NativeHost, Readiness};
use wasmtime::{Caller, Instance, Linker, Memory, Module, Store};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct Socket(u32);

type Reply<T> = mpsc::Sender<io::Result<T>>;
type Task = Box<dyn FnOnce(&mut Owner) + Send>;

enum Command {
    Run(Task),
    Flush(Instant, Reply<()>),
    Stop,
}

pub struct Actor {
    commands: mpsc::Sender<Command>,
    wake: ControlWake,
    thread: Option<JoinHandle<io::Result<()>>>,
}

impl Actor {
    pub fn new(module: &Module, notify: Arc<dyn Fn() + Send + Sync>) -> io::Result<Self> {
        let module = Embedded::new(module)?;
        let (readiness, wake) = Readiness::new()?;
        let (commands, receiver) = mpsc::channel();
        let mut owner = Owner {
            module,
            readiness,
            notify,
            sockets: BTreeMap::new(),
            retiring: BTreeMap::new(),
            flushers: Vec::new(),
            drain_error: None,
        };
        let thread = thread::Builder::new()
            .name("bun-waffle-net".into())
            .spawn(move || owner.run(receiver))?;
        Ok(Self {
            commands,
            wake,
            thread: Some(thread),
        })
    }

    fn send(&self, command: Command) -> io::Result<()> {
        self.commands.send(command).map_err(disconnected)?;
        self.wake.wake()
    }

    fn request<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Owner) -> io::Result<T> + Send + 'static,
    ) -> io::Result<T> {
        let (reply, receive) = mpsc::channel();
        self.send(Command::Run(Box::new(move |owner| {
            let _ = reply.send(operation(owner));
        })))?;
        receive.recv().map_err(disconnected)?
    }

    pub fn listen(&self, address: SocketAddr) -> io::Result<Socket> {
        self.request(move |owner| {
            owner.module.address_input(address)?;
            let id = owner.module.call0("tcp_listen")?;
            owner
                .sockets
                .insert(Socket(id as u32), Registration::Listener(false));
            Ok(Socket(id as u32))
        })
    }

    pub fn listen_default(&self, port: u16) -> io::Result<Socket> {
        self.request(move |owner| {
            let id = owner.module.call1("tcp_listen_default", u32::from(port))?;
            let socket = Socket(id as u32);
            owner.sockets.insert(socket, Registration::Listener(false));
            Ok(socket)
        })
    }

    pub fn check(&self, socket: Socket) -> io::Result<()> {
        self.request(move |owner| {
            owner.require(socket)?;
            owner.module.call1("tcp_poll", socket.0).map(|_| ())
        })
    }

    pub fn connect(&self, address: SocketAddr) -> io::Result<Socket> {
        self.request(move |owner| {
            owner.module.address_input(address)?;
            let id = owner.module.call0("tcp_connect")?;
            owner
                .sockets
                .insert(Socket(id as u32), Registration::Stream(false));
            Ok(Socket(id as u32))
        })
    }

    pub fn accept(&self, listener: Socket) -> io::Result<Socket> {
        self.request(move |owner| {
            owner.require(listener)?;
            let result = owner.module.call1("tcp_accept", listener.0);
            if let Some(Registration::Listener(notified)) = owner.sockets.get_mut(&listener) {
                *notified = false;
            }
            let id = result?;
            owner
                .sockets
                .insert(Socket(id as u32), Registration::Stream(false));
            Ok(Socket(id as u32))
        })
    }

    pub fn address(&self, socket: Socket, peer: bool) -> io::Result<SocketAddr> {
        self.request(move |owner| {
            owner.require(socket)?;
            owner.module.call1(
                if peer {
                    "tcp_peer_addr"
                } else {
                    "tcp_local_addr"
                },
                socket.0,
            )?;
            abi::decode_address(&owner.module.output(ADDRESS_SIZE)?)
        })
    }

    pub fn read(&self, socket: Socket, capacity: usize) -> io::Result<Vec<u8>> {
        self.request(move |owner| {
            owner.require(socket)?;
            let length = capacity.min(owner.module.capacity);
            let count = owner.module.call2("tcp_read", socket.0, length as u32)?;
            owner.module.output(count as usize)
        })
    }

    pub fn write(&self, socket: Socket, bytes: &[u8]) -> io::Result<usize> {
        let bytes = bytes[..bytes.len().min(abi::BUFFER_SIZE)].to_vec();
        self.request(move |owner| {
            owner.require(socket)?;
            owner.module.input(&bytes)?;
            owner
                .module
                .call2("tcp_write", socket.0, bytes.len() as u32)
                .map(|n| n as usize)
        })
    }

    pub fn shutdown(&self, socket: Socket) -> io::Result<()> {
        self.request(move |owner| {
            owner.require(socket)?;
            owner.module.call1("tcp_shutdown", socket.0).map(|_| ())
        })
    }

    pub fn close(&self, socket: Socket) -> io::Result<()> {
        self.request(move |owner| owner.retire(socket))
    }

    pub fn flush_closed(&self, limit: Duration) -> io::Result<()> {
        let (reply, receive) = mpsc::channel();
        self.send(Command::Flush(Instant::now() + limit, reply))?;
        receive.recv().map_err(disconnected)?
    }

    #[cfg(test)]
    pub fn stop(mut self) -> io::Result<()> {
        self.join()
    }

    fn join(&mut self) -> io::Result<()> {
        let Some(thread) = self.thread.take() else {
            return Ok(());
        };
        let sent = self.send(Command::Stop);
        let result = thread
            .join()
            .map_err(|_| io::Error::other("network actor panicked"))?;
        result.and(sent)
    }
}

impl Drop for Actor {
    fn drop(&mut self) {
        let _ = self.join();
    }
}

fn disconnected(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, error.to_string())
}

struct Embedded {
    store: Store<NativeHost>,
    instance: Instance,
    memory: Memory,
    buffer: usize,
    capacity: usize,
}

impl Embedded {
    fn new(module: &Module) -> io::Result<Self> {
        let mut linker = Linker::new(module.engine());
        linker
            .func_wrap("waffle_tcp_host", "io", dispatch)
            .map_err(engine_error)?;
        let mut store = Store::new(module.engine(), NativeHost::default());
        store.set_epoch_deadline(u64::MAX / 2);
        let instance = linker
            .instantiate(&mut store, module)
            .map_err(engine_error)?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| io::Error::other("network memory export missing"))?;
        if memory.ty(&store).is_shared() {
            return Err(io::Error::other("network memory must be unshared"));
        }
        let mut embedded = Self {
            store,
            instance,
            memory,
            buffer: 0,
            capacity: 0,
        };
        embedded.buffer = embedded.call0("tcp_buffer")? as usize;
        embedded.capacity = embedded.call0("tcp_capacity")? as usize;
        embedded
            .memory
            .data(&embedded.store)
            .get(embedded.buffer..embedded.buffer + embedded.capacity)
            .ok_or_else(|| io::Error::other("network scratch outside memory"))?;
        for name in [
            "tcp_next",
            "tcp_interests",
            "tcp_close_graceful",
            "tcp_close_status",
            "tcp_poll",
        ] {
            embedded
                .instance
                .get_typed_func::<u32, i32>(&mut embedded.store, name)
                .map_err(engine_error)?;
        }
        Ok(embedded)
    }

    fn call0(&mut self, name: &str) -> io::Result<i32> {
        let function = self
            .instance
            .get_typed_func::<(), i32>(&mut self.store, name)
            .map_err(engine_error)?;
        checked(function.call(&mut self.store, ()).map_err(engine_error)?)
    }

    fn call1(&mut self, name: &str, token: u32) -> io::Result<i32> {
        let function = self
            .instance
            .get_typed_func::<u32, i32>(&mut self.store, name)
            .map_err(engine_error)?;
        checked(
            function
                .call(&mut self.store, token)
                .map_err(engine_error)?,
        )
    }

    fn call2(&mut self, name: &str, token: u32, value: u32) -> io::Result<i32> {
        let function = self
            .instance
            .get_typed_func::<(u32, u32), i32>(&mut self.store, name)
            .map_err(engine_error)?;
        checked(
            function
                .call(&mut self.store, (token, value))
                .map_err(engine_error)?,
        )
    }

    fn input(&mut self, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > self.capacity {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.memory
            .write(&mut self.store, self.buffer, bytes)
            .map_err(engine_error)
    }

    fn output(&mut self, length: usize) -> io::Result<Vec<u8>> {
        if length > self.capacity {
            return Err(io::ErrorKind::InvalidData.into());
        }
        let mut bytes = vec![0; length];
        self.memory
            .read(&self.store, self.buffer, &mut bytes)
            .map_err(engine_error)?;
        Ok(bytes)
    }

    fn address_input(&mut self, address: SocketAddr) -> io::Result<()> {
        self.input(&abi::encode_address(address))
    }

    fn tokens(&mut self) -> io::Result<Vec<Socket>> {
        let mut tokens = Vec::new();
        let mut after = 0;
        loop {
            let next = self.call1("tcp_next", after)? as u32;
            if next == 0 {
                return Ok(tokens);
            }
            tokens.push(Socket(next));
            after = next;
        }
    }
}

fn checked(result: i32) -> io::Result<i32> {
    if result < 0 {
        return Err(abi::decode_error(result));
    }
    Ok(result)
}

fn engine_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
thread_local! { static WRITE_LIMIT: std::cell::Cell<u32> = const { std::cell::Cell::new(u32::MAX) }; }

fn dispatch(
    mut caller: Caller<'_, NativeHost>,
    operation: u32,
    token: u32,
    pointer: u32,
    length: u32,
) -> i32 {
    let Some(memory) = caller
        .get_export("memory")
        .and_then(|export| export.into_memory())
    else {
        return -2;
    };
    let (bytes, host) = memory.data_and_store_mut(&mut caller);
    #[cfg(test)]
    let length = if operation == abi::WRITE {
        WRITE_LIMIT.with(|limit| length.min(limit.get()))
    } else {
        length
    };
    host.dispatch(operation, token, pointer, length, bytes)
}

enum Registration {
    Listener(bool),
    Stream(bool),
}

struct Retirement {
    deadline: Instant,
    writer_finished: bool,
}

struct Owner {
    module: Embedded,
    readiness: Readiness,
    notify: Arc<dyn Fn() + Send + Sync>,
    sockets: BTreeMap<Socket, Registration>,
    retiring: BTreeMap<Socket, Retirement>,
    flushers: Vec<(Instant, Reply<()>)>,
    drain_error: Option<io::Error>,
}

impl Owner {
    fn require(&self, socket: Socket) -> io::Result<()> {
        if self.sockets.contains_key(&socket) {
            return Ok(());
        }
        Err(io::ErrorKind::NotFound.into())
    }

    fn run(&mut self, commands: mpsc::Receiver<Command>) -> io::Result<()> {
        let outcome = self.turns(commands);
        let disposed = self.module.call0("tcp_dispose");
        (self.notify)();
        outcome.and(disposed.map(|_| ()))
    }

    fn turns(&mut self, commands: mpsc::Receiver<Command>) -> io::Result<()> {
        loop {
            if self.commands(&commands) {
                return Ok(());
            }
            self.reap()?;
            self.complete_flushers();
            let interests = self.interests()?;
            let timeout = self
                .deadline()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()));
            let ready =
                self.module
                    .store
                    .data()
                    .wait_many(&interests, &mut self.readiness, timeout)?;
            for (id, _) in ready.sockets {
                self.progress(Socket(id))?;
            }
        }
    }

    fn commands(&mut self, commands: &mpsc::Receiver<Command>) -> bool {
        loop {
            match commands.try_recv() {
                Ok(Command::Run(operation)) => operation(self),
                Ok(Command::Flush(deadline, reply)) => self.flushers.push((deadline, reply)),
                Ok(Command::Stop) | Err(mpsc::TryRecvError::Disconnected) => return true,
                Err(mpsc::TryRecvError::Empty) => return false,
            }
        }
    }

    fn retire(&mut self, socket: Socket) -> io::Result<()> {
        self.require(socket)?;
        self.sockets.remove(&socket);
        let result = self.module.call1("tcp_close_graceful", socket.0);
        for token in self.module.tokens()? {
            if self.sockets.contains_key(&token) {
                continue;
            }
            self.retiring.entry(token).or_insert(Retirement {
                deadline: Instant::now() + Duration::from_secs(5),
                writer_finished: false,
            });
        }
        result.map(|_| ())
    }

    fn progress(&mut self, token: Socket) -> io::Result<()> {
        if let Some(Registration::Listener(notified)) = self.sockets.get_mut(&token) {
            *notified = true;
            (self.notify)();
            return Ok(());
        }
        let _ = self.module.call1("tcp_poll", token.0);
        (self.notify)();
        Ok(())
    }

    fn interests(&mut self) -> io::Result<Vec<(u32, u32)>> {
        let mut interests = Vec::new();
        for token in self.module.tokens()? {
            let bits = self.module.call1("tcp_interests", token.0)? as u32;
            if self.terminal_or_notified(token, bits) {
                continue;
            }
            if bits & 3 != 0 {
                interests.push((token.0, bits & 3));
            }
        }
        Ok(interests)
    }

    fn terminal_or_notified(&mut self, token: Socket, bits: u32) -> bool {
        match self.sockets.get_mut(&token) {
            Some(Registration::Listener(notified)) => *notified,
            Some(Registration::Stream(notified)) if bits & 4 != 0 => {
                if !*notified {
                    *notified = true;
                    (self.notify)();
                }
                true
            }
            _ => bits & 4 != 0,
        }
    }

    fn reap(&mut self) -> io::Result<()> {
        let tokens: Vec<_> = self.retiring.keys().copied().collect();
        for token in tokens {
            self.reap_one(token)?;
        }
        Ok(())
    }

    fn reap_one(&mut self, token: Socket) -> io::Result<()> {
        let status = self.module.call1("tcp_close_status", token.0);
        let retirement = self.retiring.get_mut(&token).expect("owned retirement");
        if let Ok(bits) = status.as_ref() {
            retirement.writer_finished = bits & 1 != 0;
        }
        let expired = Instant::now() >= retirement.deadline;
        if !expired && status.as_ref().is_ok_and(|bits| *bits != 3) {
            return Ok(());
        }
        if expired && !retirement.writer_finished {
            self.drain_error
                .get_or_insert(io::ErrorKind::TimedOut.into());
        }
        if let Err(error) = status {
            self.drain_error.get_or_insert(error);
        }
        self.module.call1("tcp_close", token.0)?;
        self.retiring.remove(&token);
        (self.notify)();
        Ok(())
    }

    fn deadline(&self) -> Option<Instant> {
        self.retiring
            .values()
            .map(|entry| entry.deadline)
            .chain(self.flushers.iter().map(|(deadline, _)| *deadline))
            .min()
    }

    fn complete_flushers(&mut self) {
        let finished = self.retiring.values().all(|entry| entry.writer_finished);
        let now = Instant::now();
        let pending = std::mem::take(&mut self.flushers);
        for (deadline, reply) in pending {
            if !finished && now < deadline {
                self.flushers.push((deadline, reply));
                continue;
            }
            let result = self.flush_result(finished);
            let _ = reply.send(result);
        }
    }

    fn flush_result(&self, finished: bool) -> io::Result<()> {
        if let Some(error) = &self.drain_error {
            return Err(io::Error::new(error.kind(), error.to_string()));
        }
        if !finished {
            return Err(io::ErrorKind::TimedOut.into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "waffle_native_tests.rs"]
mod tests;
