//! ABI-level tests of [`Net`] without a guest: loopback only.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use super::*;

/// Calls `f` until it stops returning AGAIN, polling in between.
fn wait(net: &mut Net, mut f: impl FnMut(&mut Net) -> i32) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = f(net);
        if result != AGAIN {
            return result;
        }
        assert!(Instant::now() < deadline, "timed out waiting");
        net.poll(1000);
    }
}

fn json(output: Output) -> serde_json::Value {
    match output {
        Output::Bytes(bytes) => serde_json::from_slice(&bytes).unwrap(),
        Output::Code(code) => panic!("expected bytes, got {code}"),
    }
}

fn read_all(net: &mut Net, handle: i32) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match wait(net, |net| net.read(handle, &mut buf)) {
            0 => return out,
            n if n > 0 => out.extend_from_slice(&buf[..n as usize]),
            n => panic!("read failed: {n}"),
        }
    }
}

#[test]
fn handle_capacity_stops_at_the_process_namespace() {
    let mut net = Net::new();
    net.next_handle = crate::process::FIRST_HANDLE - 1;
    assert!(net.require_handle().is_ok());
    net.next_handle += 1;
    for _ in 0..3 {
        let error = net.require_handle().unwrap_err();
        assert_eq!(error.code.as_deref(), Some("EAGAIN"));
        assert_eq!(net.next_handle, crate::process::FIRST_HANDLE);
        assert!(net.handles.is_empty());
    }
}

#[test]
fn exhausted_network_operations_report_error_without_starting_io() {
    let mut net = Net::new();
    net.next_handle = crate::process::FIRST_HANDLE;
    for operation in 0..3 {
        let result = match operation {
            0 => net.fetch(br#"{"url":"http://127.0.0.1:9/"}"#, b""),
            1 => net.listen("127.0.0.1", 0),
            _ => net.connect("127.0.0.1", 9),
        };
        assert_eq!(result, ERROR);
        assert_eq!(json(net.error(0))["code"], "EAGAIN");
        assert_eq!(net.next_handle, crate::process::FIRST_HANDLE);
        assert!(net.handles.is_empty());
    }
    // Descriptor errors keep their original result and do not overwrite error(0).
    assert_eq!(net.accept(123), BADF);
    assert_eq!(json(net.error(0))["code"], "EAGAIN");
    assert_eq!(net.connect("127.0.0.1", -1), ERROR);
    assert_eq!(json(net.error(0))["code"], "ERR_SOCKET_BAD_PORT");
}

#[test]
fn last_network_handle_remains_below_process_handles_and_is_not_reused() {
    let mut net = Net::new();
    net.next_handle = crate::process::FIRST_HANDLE - 1;
    let listener = net.listen("127.0.0.1", 0);
    assert_eq!(listener, crate::process::FIRST_HANDLE - 1);
    assert_eq!(net.next_handle, crate::process::FIRST_HANDLE);
    assert_eq!(net.listen("127.0.0.1", 0), ERROR);
    assert_eq!(json(net.error(0))["code"], "EAGAIN");
    assert_eq!(net.close(listener), 0);
    assert!(net.handles.is_empty());
    assert_eq!(net.listen("127.0.0.1", 0), ERROR);
    assert_eq!(net.next_handle, crate::process::FIRST_HANDLE);
}

#[test]
fn exhausted_accept_preserves_the_pending_connection() {
    // Net owns every listener/connection and closes them during unwind too.
    let mut net = Net::new();
    let listener = net.listen("127.0.0.1", 0);
    assert!(listener > 0);
    let mut client = TcpStream::connect(("127.0.0.1", net.local_port(listener) as u16)).unwrap();
    // Before sending data there are exactly two notifications: connection
    // readiness and accept publication. Both prove the socket is queued,
    // without assuming how many TCP reads will receive the message below.
    let deadline = Instant::now() + Duration::from_secs(10);
    while *net.notify.generation.lock().unwrap() < 2 {
        assert!(Instant::now() < deadline, "connection was not queued");
        net.poll(1000);
    }
    net.next_handle = crate::process::FIRST_HANDLE;
    assert_eq!(net.accept(listener), ERROR);
    assert_eq!(json(net.error(0))["code"], "EAGAIN");
    // Test-only restoration of one free ID exposes whether rejection popped it.
    net.next_handle -= 1;
    let conn = net.accept(listener);
    assert_eq!(conn, crate::process::FIRST_HANDLE - 1);
    client.write_all(b"ping").unwrap();
    client.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(read_all(&mut net, conn), b"ping");
    assert_eq!(net.close(conn), 0);
    drop(client);
    net.flush_closed(Duration::from_secs(1));
    assert_eq!(net.close(listener), 0);
    assert!(net.handles.is_empty());
}

#[test]
fn poll_times_out_and_reports_new_events_once() {
    let mut net = Net::new();
    assert_eq!(net.poll(0), 0);
    assert_eq!(net.poll(20), 0);
    net.notify.bump();
    assert_eq!(net.poll(-1), 1);
    assert_eq!(net.poll(0), 0);
}

#[test]
fn listen_accept_echo_and_close() {
    let mut net = Net::new();
    let listener = net.listen("127.0.0.1", 0);
    assert!(listener > 0);
    let port = net.local_port(listener) as u16;

    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let conn = wait(&mut net, |net| net.accept(listener));
    assert!(conn > 0);
    let peer = json(net.peer_addr(conn));
    assert_eq!(peer["address"], "127.0.0.1");
    assert_eq!(peer["family"], "IPv4");

    client.write_all(b"ping").unwrap();
    let mut buf = [0u8; 16];
    let n = wait(&mut net, |net| net.read(conn, &mut buf));
    assert_eq!(&buf[..n as usize], b"ping");

    assert_eq!(net.write(conn, b"pong"), 4);
    assert_eq!(net.close(conn), 0);
    assert_eq!(net.read(conn, &mut buf), BADF);
    let mut reply = Vec::new();
    client.read_to_end(&mut reply).unwrap();
    assert_eq!(reply, b"pong");

    // Closing the listener frees the port: new connections are refused.
    assert_eq!(net.close(listener), 0);
    assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    assert_eq!(net.close(listener), BADF);
}

#[test]
fn listen_reports_address_in_use() {
    let mut net = Net::new();
    let first = net.listen("127.0.0.1", 0);
    let port = net.local_port(first);
    assert_eq!(net.listen("127.0.0.1", port), ERROR);
    let error = json(net.error(0));
    assert_eq!(error["code"], "EADDRINUSE");
    assert_eq!(
        error["message"],
        format!("Failed to start server. Is port {port} in use?")
    );
}

#[test]
fn connect_write_backpressure_and_refused() {
    let mut net = Net::new();
    let listener = net.listen("localhost", 0);
    let port = net.local_port(listener);
    let conn = net.connect("127.0.0.1", port);
    let server = wait(&mut net, |net| net.accept(listener));

    // Writes return AGAIN until connected, then queue until the high-water
    // mark (the server side doesn't read yet, so the kernel buffers fill up).
    let chunk = vec![7u8; 256 * 1024];
    let mut sent = 0usize;
    let mut again_after_connect = false;
    while !again_after_connect {
        match net.write(conn, &chunk) {
            AGAIN if sent > 0 => again_after_connect = true,
            AGAIN => {
                net.poll(100);
            }
            n => sent += n as usize,
        }
    }
    assert!(sent >= 1 << 20, "queued {sent}");
    assert_eq!(net.close(conn), 0);
    assert_eq!(read_all(&mut net, server).len(), sent);

    let refused = net.connect("127.0.0.1", 9);
    assert_eq!(wait(&mut net, |net| net.write(refused, b"x")), ERROR);
    let error = json(net.error(refused));
    assert_eq!(error["code"], "ECONNREFUSED");
    assert_eq!(error["message"], "connect ECONNREFUSED 127.0.0.1:9");
}

/// A one-shot HTTP server on a loopback port; returns the port.
fn http_server(response: &'static [u8]) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        stream.write_all(response).unwrap();
    });
    port
}

#[test]
fn fetch_reports_reason_phrase_and_decodes_gzip() {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(b"hello gzip").unwrap();
    let body = gz.finish().unwrap();
    let mut response = format!(
        "HTTP/1.1 418 I'm a Teapot\r\ncontent-encoding: gzip\r\ncontent-length: {}\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(&body);
    let port = http_server(Box::leak(response.into_boxed_slice()));

    let mut net = Net::new();
    let meta =
        format!(r#"{{"method":"GET","url":"http://127.0.0.1:{port}/x","headers":[["x-a","1"]]}}"#);
    let handle = net.fetch(meta.as_bytes(), b"");
    assert!(handle > 0);
    let head = loop {
        match net.fetch_head(handle) {
            Output::Code(AGAIN) => {
                net.poll(1000);
            }
            output => break json(output),
        }
    };
    assert_eq!(head["status"], 418);
    assert_eq!(head["statusText"], "I'm a Teapot");
    assert_eq!(head["redirected"], false);
    assert_eq!(read_all(&mut net, handle), b"hello gzip");
    assert_eq!(net.close(handle), 0);
}

fn fetch_head_ready(net: &mut Net, fetch: i32) -> i32 {
    match net.fetch_head(fetch) {
        Output::Code(code) => code,
        Output::Bytes(_) => 0,
    }
}

fn waiting_fetch(net: &mut Net) -> (i32, i32, i32) {
    let listener = net.listen("127.0.0.1", 0);
    assert!(listener > 0);
    let port = net.local_port(listener);
    let meta = format!(r#"{{"url":"http://127.0.0.1:{port}/"}}"#);
    let fetch = net.fetch(meta.as_bytes(), b"");
    assert!(fetch > 0);
    let peer = wait(net, |net| net.accept(listener));
    assert!(peer > 0);
    let mut request = Vec::new();
    let mut buf = [0u8; 4096];
    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let count = wait(net, |net| net.read(peer, &mut buf));
        assert!(count > 0);
        request.extend_from_slice(&buf[..count as usize]);
    }
    (fetch, listener, peer)
}

/// Keep the peer open without a complete response, then close only the fetch
/// handle. The peer must observe EOF before it sends any more response bytes.
fn assert_fetch_abort_disconnects(after_headers: bool) {
    let mut net = Net::new();
    let (fetch, listener, peer) = waiting_fetch(&mut net);
    let mut buf = [0u8; 4096];
    if after_headers {
        let headers = b"HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n";
        assert_eq!(net.write(peer, headers), headers.len() as i32);
        assert_eq!(wait(&mut net, |net| fetch_head_ready(net, fetch)), 0);
    }
    assert_eq!(net.close(fetch), 0);
    assert_eq!(wait(&mut net, |net| net.read(peer, &mut buf)), 0);
    assert_eq!(net.close(fetch), BADF);
    assert_eq!(net.close(peer), 0);
    assert_eq!(net.close(listener), 0);
    net.flush_closed(Duration::from_secs(1));
    assert!(net.handles.is_empty());
}

#[test]
fn fetch_abort_disconnects_before_response_headers() {
    assert_fetch_abort_disconnects(false);
}

#[test]
fn fetch_abort_disconnects_during_response_body_read() {
    assert_fetch_abort_disconnects(true);
}

#[test]
fn fetch_abort_does_not_cancel_another_pending_request() {
    let mut net = Net::new();
    let (cancelled, first_listener, first_peer) = waiting_fetch(&mut net);
    let (active, second_listener, second_peer) = waiting_fetch(&mut net);
    let mut buf = [0u8; 4096];
    assert_eq!(net.close(cancelled), 0);
    assert_eq!(wait(&mut net, |net| net.read(first_peer, &mut buf)), 0);
    assert!(matches!(net.fetch_head(active), Output::Code(AGAIN)));
    let response = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    assert_eq!(net.write(second_peer, response), response.len() as i32);
    assert_eq!(wait(&mut net, |net| fetch_head_ready(net, active)), 0);
    assert_eq!(json(net.fetch_head(active))["status"], 200);
    assert_eq!(read_all(&mut net, active), b"ok");
    for handle in [
        active,
        first_peer,
        second_peer,
        first_listener,
        second_listener,
    ] {
        assert_eq!(net.close(handle), 0);
    }
    net.flush_closed(Duration::from_secs(1));
    assert!(net.handles.is_empty());
}

#[test]
fn fetch_errors() {
    let mut net = Net::new();
    let handle = net.fetch(br#"{"url":"http://127.0.0.1:9/"}"#, b"");
    assert!(handle > 0);
    let result = loop {
        match net.fetch_head(handle) {
            Output::Code(AGAIN) => {
                net.poll(1000);
            }
            Output::Code(code) => break code,
            Output::Bytes(_) => panic!("expected an error"),
        }
    };
    assert_eq!(result, ERROR);
    assert_eq!(json(net.error(handle))["code"], "ConnectionRefused");

    assert_eq!(net.fetch(br#"{"url":"ftp://x/"}"#, b""), ERROR);
    assert_eq!(json(net.error(0))["code"], "ERR_INVALID_ARG_VALUE");
}

#[test]
fn notify_wait_past_ends_on_a_bump_made_before_or_during_the_wait() {
    let notify = Notify::new();
    let seen = notify.generation();
    let bumper = notify.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(50));
        bumper.bump();
    });
    let started = Instant::now();
    notify.wait_past(seen, Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(5));
    thread.join().unwrap();

    // A change between reading the generation and waiting is not lost.
    let seen = notify.generation();
    notify.bump();
    let started = Instant::now();
    notify.wait_past(seen, Duration::from_secs(10));
    assert!(started.elapsed() < Duration::from_secs(5));

    // Without a change the wait ends at its timeout.
    let started = Instant::now();
    notify.wait_past(notify.generation(), Duration::from_millis(20));
    assert!(started.elapsed() >= Duration::from_millis(20));
}

#[test]
fn lookup_publishes_ordered_family_results_wakes_poll_and_is_repeatable_until_close() {
    let mut net = Net::new();
    let handle = net.lookup("localhost", 6, 0);
    assert!(handle > 0);
    let first = loop {
        match net.lookup_head(handle) {
            Output::Code(AGAIN) => {
                assert_eq!(net.poll(5000), 1);
            }
            output => break output,
        }
    };
    let bytes = match first {
        Output::Bytes(bytes) => bytes,
        Output::Code(code) => panic!("unexpected lookup result {code}"),
    };
    let repeat = match net.lookup_head(handle) {
        Output::Bytes(bytes) => bytes,
        Output::Code(code) => panic!("unexpected repeated lookup result {code}"),
    };
    assert_eq!(bytes, repeat);
    let value = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap();
    assert!(
        value["addresses"]
            .as_array()
            .unwrap()
            .iter()
            .all(|address| address["family"] == 6)
    );
    assert_eq!(net.close(handle), 0);
    assert_eq!(net.close(handle), BADF);
    assert!(matches!(net.lookup_head(handle), Output::Code(BADF)));
}

#[test]
fn lookup_error_preserves_hostname_and_getaddrinfo_metadata_until_close() {
    let mut net = Net::new();
    let hostname = "bun-wasm-native-dns.invalid";
    let handle = net.lookup(hostname, 0, 0);
    assert!(handle > 0);
    loop {
        match net.lookup_head(handle) {
            Output::Code(AGAIN) => assert_eq!(net.poll(5000), 1),
            Output::Code(ERROR) => break,
            Output::Bytes(_) => panic!("unexpected successful lookup"),
            Output::Code(code) => panic!("unexpected lookup status {code}"),
        }
    }
    let error = json(net.error(handle));
    assert_eq!(error["code"], "ENOTFOUND");
    assert_eq!(error["syscall"], "getaddrinfo");
    assert_eq!(error["hostname"], hostname);
    assert_eq!(net.close(handle), 0);
    assert!(matches!(net.error(handle), Output::Code(BADF)));
}
