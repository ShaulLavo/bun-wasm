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

/// A one-shot server that records the request until `complete` says it has
/// all of it, then sends `response`. The thread returns what it recorded.
fn recording_server(
    complete: fn(&[u8]) -> bool,
    response: &'static [u8],
) -> (u16, std::thread::JoinHandle<Vec<u8>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut recorded = Vec::new();
        let mut buf = [0u8; 4096];
        while !complete(&recorded) {
            let count = stream.read(&mut buf).unwrap();
            assert!(count > 0, "the client closed early: {recorded:?}");
            recorded.extend_from_slice(&buf[..count]);
        }
        stream.write_all(response).unwrap();
        recorded
    });
    (port, thread)
}

fn request_body(recorded: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(recorded).into_owned();
    let end = text.find("\r\n\r\n").expect("a request head");
    (
        text[..end].to_ascii_lowercase(),
        text[end + 4..].to_string(),
    )
}

/// Writes `chunks` to a `fetch_stream` handle, ends the body and returns the head.
fn stream_upload(net: &mut Net, handle: i32, chunks: &[&[u8]]) -> serde_json::Value {
    for chunk in chunks {
        assert_eq!(
            wait(net, |net| net.write(handle, chunk)),
            chunk.len() as i32
        );
    }
    assert_eq!(net.shutdown(handle), 0);
    assert_eq!(wait(net, |net| fetch_head_ready(net, handle)), 0);
    json(net.fetch_head(handle))
}

#[test]
fn fetch_stream_sends_each_write_as_one_chunk_and_skips_empty_writes() {
    let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
    let (port, server) = recording_server(|bytes| bytes.ends_with(b"0\r\n\r\n"), ok);
    let mut net = Net::new();
    let meta = format!(r#"{{"method":"POST","url":"http://127.0.0.1:{port}/"}}"#);
    let handle = net.fetch_stream(meta.as_bytes());
    assert!(handle > 0);
    let head = stream_upload(&mut net, handle, &[b"", b"AAAA", b"", b"BBBB"]);
    assert_eq!(head["status"], 200);
    assert_eq!(read_all(&mut net, handle), b"ok");
    assert_eq!(net.write(handle, b"late"), ERROR);
    let (head, body) = request_body(&server.join().unwrap());
    assert!(head.contains("transfer-encoding: chunked"), "{head}");
    assert!(!head.contains("content-length"), "{head}");
    assert_eq!(body, "4\r\nAAAA\r\n4\r\nBBBB\r\n0\r\n\r\n");
    assert_eq!(net.close(handle), 0);
}

#[test]
fn fetch_stream_keeps_the_callers_content_length() {
    let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
    let (port, server) = recording_server(|bytes| bytes.ends_with(b"AAAABBBB"), ok);
    let mut net = Net::new();
    let meta = format!(
        r#"{{"method":"POST","url":"http://127.0.0.1:{port}/","headers":[["content-length","8"]]}}"#
    );
    let handle = net.fetch_stream(meta.as_bytes());
    let head = stream_upload(&mut net, handle, &[b"AAAA", b"", b"BBBB"]);
    assert_eq!(head["status"], 200);
    let (head, body) = request_body(&server.join().unwrap());
    assert!(head.contains("content-length: 8"), "{head}");
    assert!(!head.contains("transfer-encoding"), "{head}");
    assert_eq!(body, "AAAABBBB");
    assert_eq!(net.close(handle), 0);
}

#[test]
fn fetch_stream_reports_backpressure_until_the_body_is_sent() {
    // Nobody reads the upload, so the queue fills and `write` asks the guest to wait.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut net = Net::new();
    let meta = format!(r#"{{"method":"PUT","url":"http://127.0.0.1:{port}/"}}"#);
    let handle = net.fetch_stream(meta.as_bytes());
    let chunk = vec![b'x'; 64 * 1024];
    let mut accepted = 0usize;
    while net.write(handle, &chunk) != AGAIN {
        accepted += chunk.len();
        assert!(accepted <= 64 << 20, "write never reported backpressure");
    }
    assert_eq!(net.close(handle), 0);
    drop(listener);
}

#[test]
fn fetch_stream_follows_only_a_303_redirect() {
    let moved = b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let (port, _server) = recording_server(|bytes| bytes.ends_with(b"0\r\n\r\n"), moved);
    let mut net = Net::new();
    let meta = format!(r#"{{"method":"POST","url":"http://127.0.0.1:{port}/start"}}"#);
    let handle = net.fetch_stream(meta.as_bytes());
    assert_eq!(net.write(handle, b"data"), 4);
    assert_eq!(net.shutdown(handle), 0);
    assert_eq!(wait(&mut net, |net| fetch_head_ready(net, handle)), ERROR);
    let error = json(net.error(handle));
    assert_eq!(
        error["message"],
        "Request body is a ReadableStream and cannot be replayed for this redirect"
    );
    assert!(
        error.get("code").is_none_or(|code| code.is_null()),
        "{error}"
    );
    assert_eq!(net.close(handle), 0);

    // A fetch with a buffered body takes no writes.
    let buffered = net.fetch(br#"{"url":"http://127.0.0.1:9/"}"#, b"");
    assert_eq!(net.write(buffered, b"x"), BADF);
    assert_eq!(net.shutdown(buffered), BADF);
    assert_eq!(net.close(buffered), 0);
}

#[test]
fn fetch_sends_no_fragment_and_reads_header_bytes_as_latin1() {
    let response = b"HTTP/1.1 200 OK\r\nX-Name: caf\xc3\xa9 \xe9\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let (port, server) = recording_server(|bytes| bytes.ends_with(b"\r\n\r\n"), response);
    let mut net = Net::new();
    let fragment = "f".repeat(70_000);
    let meta = format!(r#"{{"url":"http://127.0.0.1:{port}/path?q=1#{fragment}"}}"#);
    let handle = net.fetch(meta.as_bytes(), b"");
    assert_eq!(wait(&mut net, |net| fetch_head_ready(net, handle)), 0);
    let head = json(net.fetch_head(handle));
    assert_eq!(
        head["url"],
        format!("http://127.0.0.1:{port}/path?q=1#{fragment}")
    );
    assert_eq!(head["redirected"], false);
    let name = head["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| pair[0] == "x-name")
        .map(|pair| pair[1].clone());
    assert_eq!(name.unwrap(), "caf\u{c3}\u{a9} \u{e9}");
    let (request, _) = request_body(&server.join().unwrap());
    assert!(request.starts_with("get /path?q=1 http/1.1"), "{request}");
    assert_eq!(net.close(handle), 0);
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

/// The head of a fetch from a one-shot server: `Ok(head)` or `Err(error)`.
fn fetch_once(
    response: &'static [u8],
    redirect: &str,
) -> Result<serde_json::Value, serde_json::Value> {
    let port = http_server(response);
    let mut net = Net::new();
    let meta = format!(r#"{{"url":"http://127.0.0.1:{port}/start","redirect":"{redirect}"}}"#);
    let handle = net.fetch(meta.as_bytes(), b"");
    assert!(handle > 0);
    loop {
        match net.fetch_head(handle) {
            Output::Code(AGAIN) => {
                net.poll(1000);
            }
            Output::Code(_) => return Err(json(net.error(handle))),
            output => return Ok(json(output)),
        }
    }
}

#[test]
fn fetch_reports_malformed_responses_with_buns_codes() {
    let cases: [(&[u8], &str); 4] = [
        (b"HTTP/1.1 302 Found\r\nLocation: /a\x0bb\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", "Malformed_HTTP_Response"),
        (b"HTTP/1.1 302 Found\r\nLocation: /a\x7fb\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", "Malformed_HTTP_Response"),
        (b"HTTP/1.1 200 OK\r\nSet-Cookie: sid=1;\r\n Secure; HttpOnly\r\nContent-Length: 2\r\n\r\nok", "Malformed_HTTP_Response"),
        (b"HTTP/1.1 200 OK\r\nContent-Length: 1_0\r\nConnection: close\r\n\r\n0123456789", "InvalidContentLength"),
    ];
    for (response, code) in cases {
        let error = fetch_once(response, "follow").expect_err("a malformed response is rejected");
        assert_eq!(error["code"], code, "{error}");
        let message = error["message"].as_str().unwrap();
        assert!(
            message.starts_with(&format!("{code} fetching \"http://127.0.0.1:")),
            "{message}"
        );
    }
}

#[test]
fn fetch_redirect_error_rejects_only_redirect_statuses() {
    for status in [301, 302, 303, 307, 308] {
        let response =
            format!("HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let error = fetch_once(Box::leak(response.into_bytes().into_boxed_slice()), "error")
            .expect_err("a redirect status is rejected");
        assert_eq!(error["code"], "UnexpectedRedirect", "{status}");
    }
    for status in [300, 304, 305, 306] {
        let response = format!(
            "HTTP/1.1 {status} X\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let head = fetch_once(Box::leak(response.into_bytes().into_boxed_slice()), "error")
            .expect("a 3xx that is not a redirect is returned");
        assert_eq!(head["status"], status);
    }
}

#[test]
fn fetch_rejects_a_redirect_to_a_non_http_scheme() {
    for location in ["file:/etc/hosts", "file:hosts", "data:text/plain,hi"] {
        let response = format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        let error = fetch_once(
            Box::leak(response.into_bytes().into_boxed_slice()),
            "follow",
        )
        .expect_err("the redirect is not followed");
        assert_eq!(error["code"], "UnsupportedRedirectProtocol", "{location}");
    }
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
