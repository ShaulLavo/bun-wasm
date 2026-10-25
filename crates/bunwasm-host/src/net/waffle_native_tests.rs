use super::*;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::{Condvar, Mutex, OnceLock};
use wasmtime::Engine;

const BOUND: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Changes(Mutex<u64>, Condvar);

impl Changes {
    fn mark(&self) -> u64 {
        *self.0.lock().unwrap()
    }
    fn bump(&self) {
        *self.0.lock().unwrap() += 1;
        self.1.notify_all();
    }
    fn wait(&self, generation: u64) {
        let value = self.0.lock().unwrap();
        let (value, timeout) = self
            .1
            .wait_timeout_while(value, BOUND, |value| *value == generation)
            .unwrap();
        assert!(
            !timeout.timed_out() || *value != generation,
            "actor failed to notify"
        );
    }
}

fn module() -> &'static Module {
    static MODULE: OnceLock<Module> = OnceLock::new();
    MODULE.get_or_init(|| {
        Module::new(
            &Engine::default(),
            include_bytes!(env!("BUN_WAFFLE_NETWORK_MODULE")),
        )
        .unwrap()
    })
}

fn actor() -> (Actor, Arc<Changes>) {
    let changes = Arc::new(Changes::default());
    let notify = changes.clone();
    (
        Actor::new(module(), Arc::new(move || notify.bump())).unwrap(),
        changes,
    )
}

fn loopback() -> SocketAddr {
    SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 0)
}

fn retry<T>(changes: &Changes, mut action: impl FnMut() -> io::Result<T>) -> T {
    loop {
        let generation = changes.mark();
        match action() {
            Ok(value) => return value,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => changes.wait(generation),
            Err(error) => panic!("unexpected operation failure: {error}"),
        }
    }
}

fn connect_peer(actor: &Actor, changes: &Changes, listener: Socket) -> (TcpStream, Socket) {
    let address = actor.address(listener, false).unwrap();
    let peer = TcpStream::connect_timeout(
        &SocketAddr::new(Ipv4Addr::LOCALHOST.into(), address.port()),
        BOUND,
    )
    .unwrap();
    peer.set_read_timeout(Some(BOUND)).unwrap();
    peer.set_write_timeout(Some(BOUND)).unwrap();
    let accepted = retry(changes, || actor.accept(listener));
    (peer, accepted)
}

#[test]
fn ready_b_after_idle_a_and_listener_notice_is_consumed_once() {
    let (actor, changes) = actor();
    let listener = actor.listen(loopback()).unwrap();
    let (mut idle, a) = connect_peer(&actor, &changes, listener);
    let (mut ready, b) = connect_peer(&actor, &changes, listener);
    assert!(a < b);
    ready.write_all(b"B").unwrap();
    assert_eq!(retry(&changes, || actor.read(b, 1)), b"B");
    assert_eq!(
        actor.read(a, 1).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    ready.shutdown(Shutdown::Write).unwrap();
    assert!(retry(&changes, || actor.read(b, 1)).is_empty());
    actor.close(listener).unwrap();
    let replacement = actor.listen(actor.address(a, false).unwrap()).unwrap();
    actor.close(replacement).unwrap();
    actor.stop().unwrap();
    let mut byte = [0];
    assert_eq!(idle.read(&mut byte).unwrap(), 0);
    assert_eq!(ready.read(&mut byte).unwrap(), 0);
}

#[test]
fn graceful_close_drives_one_admitted_write_and_fin_before_peer_eof() {
    let (actor, changes) = actor();
    let listener = actor.listen(loopback()).unwrap();
    let (mut peer, accepted) = connect_peer(&actor, &changes, listener);
    actor
        .request(|_| {
            WRITE_LIMIT.with(|limit| limit.set(2));
            Ok(())
        })
        .unwrap();
    peer.write_all(b"unread incoming body").unwrap();
    let body = b"one guest write must drain through OS readiness without another write";
    assert_eq!(actor.write(accepted, body).unwrap(), body.len());
    actor.close(accepted).unwrap();
    assert_eq!(
        actor.read(accepted, 1).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    actor.flush_closed(BOUND).unwrap();
    let mut bytes = Vec::new();
    peer.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, body);
    let status = actor
        .request(move |owner| owner.module.call1("tcp_close_status", accepted.0))
        .unwrap();
    assert_eq!(status, 1, "writer completion must not wait for peer EOF");
    peer.shutdown(Shutdown::Write).unwrap();
    retry(&changes, || {
        actor.request(move |owner| {
            if owner.retiring.contains_key(&accepted) {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            Ok(())
        })
    });
    assert_eq!(
        actor.request(move |owner| owner.module.tokens()).unwrap(),
        vec![listener]
    );
    actor.stop().unwrap();
}

#[test]
fn pending_listener_retirement_drains_private_tokens_and_requires_eof() {
    let (actor, changes) = actor();
    let listener = actor.listen(loopback()).unwrap();
    let address = actor.address(listener, false).unwrap();
    let mut pending = TcpStream::connect_timeout(&address, BOUND).unwrap();
    pending.set_read_timeout(Some(BOUND)).unwrap();
    pending
        .write_all(b"request queued before listener close")
        .unwrap();
    actor.close(listener).unwrap();
    actor.flush_closed(BOUND).unwrap();
    let mut bytes = Vec::new();
    pending.read_to_end(&mut bytes).unwrap();
    assert!(bytes.is_empty());
    pending.shutdown(Shutdown::Write).unwrap();
    retry(&changes, || {
        actor.request(|owner| {
            if !owner.retiring.is_empty() {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            Ok(())
        })
    });
    let replacement = actor.listen(address).unwrap();
    actor.close(replacement).unwrap();
    actor.stop().unwrap();
}

#[test]
fn stop_wakes_idle_wait_disposes_joins_and_new_owner_reuses_port() {
    let (actor, changes) = actor();
    let listener = actor.listen(loopback()).unwrap();
    let address = actor.address(listener, false).unwrap();
    let (mut peer, _) = connect_peer(&actor, &changes, listener);
    actor.request(|_| Ok(())).unwrap();
    let (done, completed) = mpsc::channel();
    let joining = thread::spawn(move || {
        done.send(actor.stop()).unwrap();
    });
    completed
        .recv_timeout(BOUND)
        .expect("OS wait must be interrupted")
        .unwrap();
    joining.join().unwrap();
    let mut byte = [0];
    assert_eq!(peer.read(&mut byte).unwrap(), 0);
    let (replacement, _) = super::tests::actor();
    replacement.listen(address).unwrap();
    replacement.stop().unwrap();
}

#[test]
fn connect_uses_fresh_owner_memory_and_half_close_delivers_eof() {
    let listener = TcpListener::bind(loopback()).unwrap();
    let address = listener.local_addr().unwrap();
    let (actor, changes) = actor();
    let socket = actor.connect(address).unwrap();
    let (mut peer, _) = listener.accept().unwrap();
    peer.set_read_timeout(Some(BOUND)).unwrap();
    peer.write_all(b"server").unwrap();
    peer.shutdown(Shutdown::Write).unwrap();
    assert_eq!(retry(&changes, || actor.read(socket, 6)), b"server");
    assert!(retry(&changes, || actor.read(socket, 1)).is_empty());
    assert_eq!(actor.write(socket, b"client").unwrap(), 6);
    actor.shutdown(socket).unwrap();
    let mut received = Vec::new();
    peer.read_to_end(&mut received).unwrap();
    assert_eq!(received, b"client");
    actor.close(socket).unwrap();
    actor.flush_closed(BOUND).unwrap();
    actor.stop().unwrap();
}

#[test]
fn negative_status_is_failure_not_writer_completion() {
    assert_eq!(checked(-1).unwrap_err().kind(), io::ErrorKind::WouldBlock);
    assert_eq!(
        checked(-14).unwrap_err().kind(),
        io::ErrorKind::HostUnreachable
    );
    assert_eq!(
        checked(-15).unwrap_err().kind(),
        io::ErrorKind::NetworkUnreachable
    );
    assert_eq!(checked(-16).unwrap_err().kind(), io::ErrorKind::NetworkDown);
    let (actor, _) = actor();
    actor
        .request(|owner| {
            owner.drain_error = Some(io::ErrorKind::BrokenPipe.into());
            Ok(())
        })
        .unwrap();
    assert_eq!(
        actor.flush_closed(BOUND).unwrap_err().kind(),
        io::ErrorKind::BrokenPipe
    );
    actor.stop().unwrap();
}
