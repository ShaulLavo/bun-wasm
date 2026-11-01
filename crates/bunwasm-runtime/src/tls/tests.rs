use super::owned::{Meter, Session};
use super::*;
use bunwasm_crypto_sys::tls as ffi;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const FULL: Allowance = Allowance {
    plaintext: MAX_BATCH,
    ciphertext: MAX_BATCH,
};
const NO_READ: Allowance = Allowance {
    plaintext: 0,
    ciphertext: MAX_BATCH,
};
const ALPN: &[u8] = b"\x08http/1.1";

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        use std::os::unix::fs::DirBuilderExt;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "bun-wasm-tls-native-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .unwrap();
        Self(path)
    }
    fn openssl(&self, arguments: &[&str]) {
        let output = std::process::Command::new("openssl")
            .args(arguments)
            .current_dir(&self.0)
            .output()
            .expect("native TLS tests require OpenSSL");
        assert!(
            output.status.success(),
            "TLS test certificate generation failed"
        );
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("remove owned TLS fixture directory");
    }
}

pub(super) struct Fixture {
    pub(super) certificate: Vec<u8>,
    key: Vec<u8>,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let scratch = Scratch::new();
        scratch.openssl(&[
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-keyout",
            "key.pem",
            "-out",
            "cert.pem",
            "-subj",
            "/CN=tls-native.test",
            "-days",
            "2",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-addext",
            "keyUsage=critical,digitalSignature,keyCertSign",
            "-addext",
            "extendedKeyUsage=serverAuth,clientAuth",
            "-addext",
            "subjectAltName=DNS:tls-native.test,IP:127.0.0.1",
        ]);
        Self {
            certificate: std::fs::read(scratch.0.join("cert.pem")).unwrap(),
            key: std::fs::read(scratch.0.join("key.pem")).unwrap(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe {
            ffi::OPENSSL_cleanse(self.key.as_mut_ptr().cast(), self.key.len());
        }
    }
}

pub(super) struct Server {
    session: Session,
    _context: Rc<context::Context>,
    pub(super) handshaken: bool,
    failed: bool,
    read_closed: bool,
}
unsafe extern "C" fn select_http11(
    _ssl: *mut ffi::Ssl,
    output: *mut *const u8,
    output_len: *mut u8,
    input: *const u8,
    input_len: std::ffi::c_uint,
    _argument: *mut std::ffi::c_void,
) -> std::ffi::c_int {
    if input.is_null() || output.is_null() || output_len.is_null() || input_len > u16::MAX.into() {
        return ffi::SSL_TLSEXT_ERR_ALERT_FATAL;
    }
    let protocols = unsafe { std::slice::from_raw_parts(input, input_len as usize) };
    if !offers_http11(protocols) {
        return ffi::SSL_TLSEXT_ERR_ALERT_FATAL;
    }
    unsafe {
        *output = ALPN.as_ptr().add(1);
        *output_len = ALPN[0];
    }
    ffi::SSL_TLSEXT_ERR_OK
}

fn offers_http11(mut protocols: &[u8]) -> bool {
    let mut found = false;
    while let Some((&length, tail)) = protocols.split_first() {
        if length == 0 || usize::from(length) > tail.len() {
            return false;
        }
        let (protocol, next) = tail.split_at(usize::from(length));
        found |= protocol == &ALPN[1..];
        protocols = next;
    }
    found
}

impl Server {
    pub(super) fn new(fixture: &Fixture, version: u16, client_auth: bool) -> Self {
        let meter = Rc::new(Meter::default());
        let mut trust = trust::Trust::new(StartupExtras::Absent, &meter);
        let options = ContextOptions {
            min_version: version,
            max_version: version,
            ca: CaMode::Explicit(vec![&fixture.certificate]),
            certificate: Some(&fixture.certificate),
            key: Some(&fixture.key),
        };
        let context = Rc::new(context::Context::server(options, &mut trust, &meter).unwrap());
        unsafe {
            ffi::SSL_CTX_set_alpn_select_cb(
                context.ssl.pointer(),
                Some(select_http11),
                std::ptr::null_mut(),
            );
        }
        let session = Session::new(context.ssl.pointer(), &meter).unwrap();
        unsafe {
            ffi::SSL_set_accept_state(session.ssl.pointer());
            ffi::SSL_set_verify(
                session.ssl.pointer(),
                if client_auth {
                    ffi::SSL_VERIFY_PEER | 2
                } else {
                    ffi::SSL_VERIFY_NONE
                },
                None,
            );
        }
        Self {
            session,
            _context: context,
            handshaken: false,
            failed: false,
            read_closed: false,
        }
    }

    fn call(&mut self, call: impl FnOnce(*mut ffi::Ssl) -> i32) -> i32 {
        owned::clear();
        let result = call(self.session.ssl.pointer());
        let error = unsafe { ffi::SSL_get_error(self.session.ssl.pointer(), result) };
        owned::capture();
        if error == ffi::SSL_ERROR_ZERO_RETURN {
            self.read_closed = true;
        }
        if ![
            ffi::SSL_ERROR_NONE,
            ffi::SSL_ERROR_WANT_READ,
            ffi::SSL_ERROR_WANT_WRITE,
            ffi::SSL_ERROR_ZERO_RETURN,
        ]
        .contains(&error)
        {
            self.failed = true;
        }
        result
    }

    pub(super) fn handshake(&mut self) {
        if self.handshaken || self.failed {
            return;
        }
        self.handshaken = self.call(|ssl| unsafe { ffi::SSL_do_handshake(ssl) }) == 1;
    }

    pub(super) fn feed(&mut self, queue: &mut VecDeque<u8>) {
        let capacity = unsafe { ffi::BIO_ctrl_get_write_guarantee(self.session.network.pointer()) };
        let input: Vec<u8> = queue.iter().take(capacity.min(31)).copied().collect();
        if input.is_empty() {
            return;
        }
        let written = unsafe {
            ffi::BIO_write(
                self.session.network.pointer(),
                input.as_ptr().cast(),
                input.len() as i32,
            )
        };
        assert!(written > 0);
        queue.drain(..written as usize);
    }

    pub(super) fn output(&mut self, queue: &mut VecDeque<u8>) {
        let pending = unsafe { ffi::BIO_ctrl_pending(self.session.network.pointer()) };
        let mut bytes = vec![0; pending.min(MAX_BATCH)];
        if bytes.is_empty() {
            return;
        }
        let read = unsafe {
            ffi::BIO_read(
                self.session.network.pointer(),
                bytes.as_mut_ptr().cast(),
                bytes.len() as i32,
            )
        };
        assert!(read > 0);
        queue.extend(bytes[..read as usize].iter().copied());
    }

    pub(super) fn read(&mut self) -> Vec<u8> {
        let mut bytes = vec![0; MAX_PLAINTEXT];
        let result = self.call(|ssl| unsafe {
            ffi::SSL_read(ssl, bytes.as_mut_ptr().cast(), bytes.len() as i32)
        });
        bytes.truncate(result.max(0) as usize);
        bytes
    }

    fn write(&mut self, bytes: &[u8]) {
        let result = self
            .call(|ssl| unsafe { ffi::SSL_write(ssl, bytes.as_ptr().cast(), bytes.len() as i32) });
        assert_eq!(result as usize, bytes.len());
    }

    fn shutdown(&mut self) {
        assert!(self.call(|ssl| unsafe { ffi::SSL_shutdown(ssl) }) >= 0);
    }
}

struct Pair {
    registry: TlsRegistry,
    id: ConnectionId,
    server: Server,
    client_wire: VecDeque<u8>,
    server_wire: VecDeque<u8>,
    peer: Option<PeerInfo>,
}
impl Pair {
    fn new(
        fixture: &Fixture,
        version: u16,
        ca: CaMode<'_>,
        startup: StartupExtras,
        identity: bool,
        client_auth: bool,
    ) -> Self {
        let mut registry = TlsRegistry::new(startup);
        let context = registry
            .create_context(ContextOptions {
                min_version: version,
                max_version: version,
                ca,
                certificate: identity.then_some(fixture.certificate.as_slice()),
                key: identity.then_some(fixture.key.as_slice()),
            })
            .unwrap();
        let id = registry
            .create_connection(
                context,
                ConnectionOptions {
                    servername: Some("tls-native.test"),
                    alpn: ALPN,
                    verify: VerifyMode::Required,
                },
            )
            .unwrap();
        registry.release_context(context).unwrap();
        Self {
            registry,
            id,
            server: Server::new(fixture, version, client_auth),
            client_wire: VecDeque::new(),
            server_wire: VecDeque::new(),
            peer: None,
        }
    }

    fn tick(&mut self, event: Option<Event<'_>>, allowance: Allowance) -> Step {
        let input: Vec<u8> = self.server_wire.iter().take(31).copied().collect();
        let event = event.unwrap_or(if input.is_empty() {
            Event::Poll
        } else {
            Event::Ciphertext(&input)
        });
        let consumes_queue = matches!(&event, Event::Ciphertext(_));
        let step = self.registry.step(self.id, event, allowance).unwrap();
        if consumes_queue {
            self.server_wire.drain(..step.accepted_ciphertext);
        }
        if let Outcome::VerificationRequired(peer) = &step.outcome {
            assert!(self.peer.is_none());
            self.peer = Some(peer.clone());
        }
        self.client_wire.extend(step.ciphertext.iter().copied());
        self.server.feed(&mut self.client_wire);
        self.server.handshake();
        self.server.output(&mut self.server_wire);
        step
    }

    fn handshake(&mut self) -> std::result::Result<(), Failure> {
        for _ in 0..10_000 {
            let step = self.tick(None, NO_READ);
            if let Outcome::Failed(failure) = step.outcome {
                return Err(failure);
            }
            if self.peer.is_some() && self.server.handshaken {
                return Ok(());
            }
            assert!(!self.server.failed, "native TLS server handshake failed");
        }
        panic!("native TLS handshake did not converge");
    }

    fn accept(&mut self) {
        self.registry.accept_identity(self.id, true, None).unwrap();
        assert!(self.registry.authorized(self.id).unwrap());
    }

    fn use_small_client(&mut self, fixture: &Fixture, capacity: usize) {
        self.registry.release_connection(self.id).unwrap();
        let context = self
            .registry
            .create_context(ContextOptions {
                ca: CaMode::Explicit(vec![&fixture.certificate]),
                ..Default::default()
            })
            .unwrap();
        let connection = driver::Connection::small_bio(
            self.registry.contexts.get(context).unwrap().clone(),
            ConnectionOptions::default(),
            &self.registry.meter,
            capacity,
        )
        .unwrap();
        self.id = self.registry.connections.insert(connection).unwrap();
        self.registry.release_context(context).unwrap();
    }

    fn flush(&mut self) {
        for _ in 0..10_000 {
            assert!(self.tick(None, FULL).plaintext.is_empty());
            if self.client_wire.is_empty() && self.server_wire.is_empty() {
                return;
            }
        }
        panic!("native TLS wire did not drain");
    }
}

#[test]
fn context_lifetime_outlives_its_released_id_and_releases_two_bios_once() {
    let mut registry = TlsRegistry::new(StartupExtras::Absent);
    let context = registry
        .create_context(ContextOptions {
            ca: CaMode::Explicit(Vec::new()),
            ..Default::default()
        })
        .unwrap();
    let connection = registry
        .create_connection(context, ConnectionOptions::default())
        .unwrap();
    assert_eq!(
        registry.release_context(context).unwrap(),
        Release::Released
    );
    assert_eq!(registry.counts().owned.contexts, 1);
    assert_eq!(registry.counts().owned.bios, 2);
    assert_eq!(
        registry.release_connection(connection).unwrap(),
        Release::Released
    );
    assert_eq!(registry.counts().owned, Counts::default());
    let counts = registry.counts();
    assert_eq!(counts.freed.contexts, 1);
    assert_eq!(counts.freed.sessions, 1);
    assert_eq!(counts.freed.bios, 2);
    assert_eq!(
        registry.release_connection(connection).unwrap(),
        Release::AlreadyReleased
    );
    assert_eq!(registry.counts().freed, counts.freed);
}

#[test]
fn registry_drop_frees_abandoned_connections() {
    let mut registry = TlsRegistry::new(StartupExtras::Absent);
    let meter = registry.meter.clone();
    for _ in 0..100 {
        let context = registry
            .create_context(ContextOptions {
                ca: CaMode::Explicit(Vec::new()),
                ..Default::default()
            })
            .unwrap();
        registry
            .create_connection(context, ConnectionOptions::default())
            .unwrap();
        registry.release_context(context).unwrap();
    }
    drop(registry);
    assert_eq!(meter.live.get(), Counts::default());
    assert_eq!(meter.freed.get().sessions, 100);
    assert_eq!(meter.freed.get().bios, 200);
}

#[test]
fn bundled_roots_lazy_set_and_full_der_parsing() {
    let meter = Rc::new(Meter::default());
    let roots = trust::bundle_slices(trust::BUNDLE).unwrap();
    for root in &roots {
        trust::der_certificate(root, &meter).unwrap();
    }
    let pointers: Vec<_> = roots.iter().map(|root| root.as_ptr()).collect();
    let lengths: Vec<_> = roots.iter().map(|root| root.len()).collect();
    let set = owned::allocated(
        || unsafe {
            ffi::X509_LAZY_CERT_SET_new_static(pointers.as_ptr(), lengths.as_ptr(), roots.len())
        },
        ffi::X509_LAZY_CERT_SET_free,
        owned::Kind::RootSet,
        &meter,
    )
    .unwrap();
    assert_eq!(unsafe { ffi::X509_LAZY_CERT_SET_num(set.pointer()) }, 121);
    for index in 0..121 {
        assert!(!unsafe { ffi::X509_LAZY_CERT_SET_get0(set.pointer(), index) }.is_null());
    }
    drop(set);
    assert_eq!(meter.live.get(), Counts::default());
}

#[test]
fn invalid_partial_context_creation_does_not_leak() {
    let fixture = Fixture::new();
    let wrong = Fixture::new();
    let mut registry = TlsRegistry::new(StartupExtras::Absent);
    let result = registry.create_context(ContextOptions {
        ca: CaMode::Explicit(Vec::new()),
        certificate: Some(&fixture.certificate),
        key: Some(&wrong.key),
        ..Default::default()
    });
    assert!(result.is_err());
    assert_eq!(registry.counts().owned, Counts::default());
    assert!(
        registry
            .create_context(ContextOptions {
                ca: CaMode::Explicit(vec![b"not a certificate"]),
                ..Default::default()
            })
            .is_err()
    );
    assert_eq!(registry.counts().owned, Counts::default());
}

#[test]
fn tls_12_and_13_verify_before_any_application_io() {
    let fixture = Fixture::new();
    for version in [ffi::TLS1_2_VERSION, ffi::TLS1_3_VERSION] {
        let mut pair = Pair::new(
            &fixture,
            version,
            CaMode::Explicit(vec![&fixture.certificate]),
            StartupExtras::Absent,
            false,
            false,
        );
        assert_eq!(
            pair.registry
                .step(pair.id, Event::Plaintext(b"early"), FULL)
                .unwrap_err()
                .code,
            "ERR_TLS_VERIFICATION_PENDING"
        );
        pair.handshake().unwrap();
        assert_eq!(
            pair.registry
                .step(pair.id, Event::Plaintext(b"early"), FULL)
                .unwrap_err()
                .code,
            "ERR_TLS_VERIFICATION_PENDING"
        );
        assert!(!pair.registry.authorized(pair.id).unwrap());
        let report = pair.peer.as_ref().unwrap();
        assert_eq!(report.alpn, b"http/1.1");
        assert_eq!(report.verify_result, 0);
        assert_eq!(
            report.protocol,
            if version == ffi::TLS1_2_VERSION {
                "TLSv1.2"
            } else {
                "TLSv1.3"
            }
        );
        let sni = unsafe { ffi::SSL_get_servername(pair.server.session.ssl.pointer(), 0) };
        assert!(!sni.is_null());
        assert_eq!(
            unsafe { std::ffi::CStr::from_ptr(sni) }.to_str().unwrap(),
            "tls-native.test"
        );
        assert_eq!(report.certificates.len(), 1);
        pair.accept();
        pair.flush();
        pair.registry.release_connection(pair.id).unwrap();
        assert_eq!(pair.registry.counts().owned, Counts::default());
    }
}

#[test]
fn explicit_empty_ca_replaces_the_valid_guest_extra_snapshot() {
    let fixture = Fixture::new();
    let mut default = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Default,
        StartupExtras::Bytes(fixture.certificate.clone()),
        false,
        false,
    );
    default.handshake().unwrap();
    let mut empty = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(Vec::new()),
        StartupExtras::Bytes(fixture.certificate.clone()),
        false,
        false,
    );
    assert_eq!(
        empty.handshake().unwrap_err().code,
        "DEPTH_ZERO_SELF_SIGNED_CERT"
    );
    assert_eq!(empty.registry.counts().owned.sessions, 0);
    assert_eq!(empty.registry.counts().owned.bios, 0);
}

#[test]
fn malformed_extra_snapshot_warns_once_and_contributes_no_trust() {
    let mut registry = TlsRegistry::new(StartupExtras::Bytes(b"bad PEM".to_vec()));
    let context = registry.create_context(ContextOptions::default()).unwrap();
    assert!(registry.take_warning().is_some());
    assert!(registry.take_warning().is_none());
    registry.release_context(context).unwrap();
    registry.create_context(ContextOptions::default()).unwrap();
    assert!(registry.take_warning().is_none());
    assert_eq!(registry.counts().owned.root_sets, 1);
}

#[test]
fn identity_rejection_and_retired_decisions_cannot_reopen_a_connection() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.handshake().unwrap();
    pair.registry
        .accept_identity(pair.id, false, Some("ERR_TLS_HOSTNAME_REQUIRED"))
        .unwrap();
    assert!(matches!(
        pair.registry
            .step(pair.id, Event::Poll, FULL)
            .unwrap()
            .outcome,
        Outcome::Failed(Failure {
            code: "ERR_TLS_HOSTNAME_REQUIRED",
            ..
        })
    ));
    assert!(pair.registry.accept_identity(pair.id, true, None).is_err());
    pair.registry.release_connection(pair.id).unwrap();
    assert!(pair.registry.accept_identity(pair.id, true, None).is_err());
    assert_eq!(pair.registry.counts().owned, Counts::default());
}

#[test]
fn bounded_write_retry_keeps_its_native_buffer_and_exact_byte_counts() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.use_small_client(&fixture, 128);
    pair.handshake().unwrap();
    pair.accept();
    pair.flush();
    let bytes: Vec<_> = (0..MAX_PLAINTEXT)
        .map(|index| (index % 251) as u8)
        .collect();
    let allowance = Allowance {
        plaintext: 0,
        ciphertext: 17,
    };
    let first = pair.tick(Some(Event::Plaintext(&bytes)), allowance);
    assert_eq!(first.accepted_plaintext, bytes.len());
    assert_eq!(first.committed_plaintext, 0);
    let pointer = pair
        .registry
        .connections
        .get(pair.id)
        .unwrap()
        .pending_write_pointer()
        .unwrap();
    let mut committed = 0;
    let mut received = Vec::new();
    let mut last_fence = None;
    for _ in 0..10_000 {
        let step = pair.tick(None, allowance);
        assert!(step.ciphertext.len() <= 17);
        committed += step.committed_plaintext;
        if step.write_ciphertext_end.is_some() {
            last_fence = step.write_ciphertext_end;
        }
        if step.pending_plaintext != 0 {
            assert_eq!(
                pair.registry
                    .connections
                    .get(pair.id)
                    .unwrap()
                    .pending_write_pointer()
                    .unwrap(),
                pointer
            );
        }
        received.extend(pair.server.read());
        if committed == bytes.len() && received.len() == bytes.len() {
            break;
        }
    }
    assert_eq!(committed, bytes.len());
    assert_eq!(received, bytes);
    assert!(last_fence.is_some());
}

#[test]
fn close_notify_fin_and_write_half_close_are_distinct() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.handshake().unwrap();
    pair.accept();
    pair.flush();
    pair.tick(Some(Event::ShutdownWrite), NO_READ);
    pair.flush();
    pair.server.write(b"after client close-notify");
    pair.server.shutdown();
    pair.server.output(&mut pair.server_wire);
    let mut received = Vec::new();
    let mut closed = false;
    for _ in 0..10_000 {
        let step = pair.tick(None, FULL);
        received.extend(step.plaintext);
        if matches!(step.outcome, Outcome::Closed) {
            closed = true;
            break;
        }
    }
    assert!(closed);
    assert_eq!(received, b"after client close-notify");
    assert_eq!(
        pair.registry
            .step(pair.id, Event::TransportEof, FULL)
            .unwrap()
            .outcome,
        Outcome::Closed
    );
    let mut truncated = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    truncated.handshake().unwrap();
    truncated.accept();
    truncated.flush();
    let result = truncated.tick(Some(Event::TransportEof), FULL);
    assert!(matches!(
        result.outcome,
        Outcome::Failed(Failure {
            code: "ERR_TLS_UNEXPECTED_EOF",
            ..
        })
    ));
}

#[test]
fn client_identity_is_verified_and_missing_identity_is_rejected() {
    let fixture = Fixture::new();
    let mut authenticated = Pair::new(
        &fixture,
        ffi::TLS1_2_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        true,
        true,
    );
    authenticated.handshake().unwrap();
    assert_eq!(
        unsafe { ffi::SSL_get_verify_result(authenticated.server.session.ssl.pointer()) },
        0
    );
    let mut missing = Pair::new(
        &fixture,
        ffi::TLS1_2_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        true,
    );
    for _ in 0..10_000 {
        let result = missing.tick(None, NO_READ);
        if missing.server.failed || matches!(result.outcome, Outcome::Failed(_)) {
            return;
        }
    }
    panic!("server accepted a client without its required certificate");
}

#[test]
fn invalid_protocol_sni_alpn_and_full_der_are_rejected() {
    assert!(driver::sni_name(Some("tls\0native.test")).is_err());
    assert!(driver::sni_name(Some("tls/native.test")).is_err());
    assert!(driver::sni_name(Some("127.0.0.1")).unwrap().is_none());
    assert!(driver::sni_name(Some("::1")).unwrap().is_none());
    assert!(driver::sni_name(Some("")).unwrap().is_none());
    assert!(driver::validate_alpn(b"\0").is_err());
    assert!(driver::validate_alpn(b"\x02a").is_err());
    let meter = Rc::new(Meter::default());
    let root = trust::bundle_slices(trust::BUNDLE).unwrap()[0];
    let mut trailing = root.to_vec();
    trailing.push(0);
    assert!(trust::der_certificate(&trailing, &meter).is_err());
    let mut registry = TlsRegistry::new(StartupExtras::Absent);
    assert!(
        registry
            .create_context(ContextOptions {
                min_version: ffi::TLS1_3_VERSION,
                max_version: ffi::TLS1_2_VERSION,
                ..Default::default()
            })
            .is_err()
    );
    assert_eq!(registry.counts().owned, Counts::default());
}

#[test]
fn verifier_reports_expired_and_not_yet_valid_with_test_only_clocks() {
    let fixture = Fixture::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    for (time, code) in [
        (now - 86_400, "CERT_NOT_YET_VALID"),
        (now + 3 * 86_400, "CERT_HAS_EXPIRED"),
    ] {
        let mut pair = Pair::new(
            &fixture,
            ffi::TLS1_3_VERSION,
            CaMode::Explicit(vec![&fixture.certificate]),
            StartupExtras::Absent,
            false,
            false,
        );
        pair.registry
            .connections
            .get_mut(pair.id)
            .unwrap()
            .set_test_verify_time(time);
        assert_eq!(pair.handshake().unwrap_err().code, code);
        assert_eq!(pair.registry.counts().owned.sessions, 0);
    }
}

#[test]
fn insecure_connection_reports_chain_failure_without_contaminating_the_next_one() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(Vec::new()),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.registry.release_connection(pair.id).unwrap();
    let context = pair
        .registry
        .create_context(ContextOptions {
            ca: CaMode::Explicit(Vec::new()),
            ..Default::default()
        })
        .unwrap();
    pair.id = pair
        .registry
        .create_connection(
            context,
            ConnectionOptions {
                verify: VerifyMode::ReportOnly,
                ..Default::default()
            },
        )
        .unwrap();
    pair.registry.release_context(context).unwrap();
    pair.handshake().unwrap();
    assert_eq!(
        pair.peer.as_ref().unwrap().authorization_error,
        Some("DEPTH_ZERO_SELF_SIGNED_CERT")
    );
    pair.registry.accept_identity(pair.id, true, None).unwrap();
    assert!(!pair.registry.authorized(pair.id).unwrap());
    pair.registry.release_connection(pair.id).unwrap();
    let mut secure = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(Vec::new()),
        StartupExtras::Absent,
        false,
        false,
    );
    assert_eq!(
        secure.handshake().unwrap_err().code,
        "DEPTH_ZERO_SELF_SIGNED_CERT"
    );
}

#[test]
fn paused_read_produces_no_plaintext_and_resumes_without_losing_bytes() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.handshake().unwrap();
    pair.accept();
    pair.flush();
    pair.server.write(b"paused plaintext");
    pair.server.output(&mut pair.server_wire);
    for _ in 0..30 {
        assert!(pair.tick(None, NO_READ).plaintext.is_empty());
    }
    let mut received = Vec::new();
    for _ in 0..30 {
        let step = pair.tick(
            None,
            Allowance {
                plaintext: 1,
                ciphertext: 1,
            },
        );
        assert!(step.plaintext.len() <= 1);
        received.extend(step.plaintext);
        if received.len() == b"paused plaintext".len() {
            break;
        }
    }
    assert_eq!(received, b"paused plaintext");
}

#[test]
fn native_table_preserves_typed_release_and_drops_its_registry() {
    use crate::data::{Args, Val};
    let mut table = crate::natives::Table::default();
    install(&mut table, StartupExtras::Absent);
    assert_eq!(table.functions.len(), 6);
    let call = |name, values: &[Val]| {
        table
            .functions
            .iter()
            .find(|(key, _)| key == &name)
            .unwrap()
            .1(Args(values))
    };
    let options = Val::Object(vec![("ca".into(), Val::Array(Vec::new()))]);
    let context = call("tlsCreateContext", &[options]).unwrap();
    let Val::Object(fields) = context else {
        panic!("context result");
    };
    let id = fields.into_iter().find(|(key, _)| key == "id").unwrap().1;
    let connection = call(
        "tlsCreateConnection",
        &[id.clone(), Val::Object(Vec::new())],
    )
    .unwrap();
    assert!(
        call(
            "tlsRelease",
            &[Val::Str("context".into()), connection.clone()]
        )
        .is_err()
    );
    call("tlsRelease", &[Val::Str("context".into()), id]).unwrap();
    call(
        "tlsRelease",
        &[Val::Str("connection".into()), connection.clone()],
    )
    .unwrap();
    call("tlsRelease", &[Val::Str("connection".into()), connection]).unwrap();
}

#[test]
fn releasing_a_suspended_write_frees_session_bios_context_and_native_buffer() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.use_small_client(&fixture, 128);
    pair.handshake().unwrap();
    pair.accept();
    pair.flush();
    let pending = pair.tick(
        Some(Event::Plaintext(&vec![7; MAX_PLAINTEXT])),
        Allowance {
            plaintext: 0,
            ciphertext: 0,
        },
    );
    assert_eq!(pending.pending_plaintext, MAX_PLAINTEXT);
    assert_eq!(
        pair.registry.release_connection(pair.id).unwrap(),
        Release::Released
    );
    assert_eq!(pair.registry.counts().owned, Counts::default());
    let freed = pair.registry.counts().freed;
    assert_eq!(
        pair.registry.release_connection(pair.id).unwrap(),
        Release::AlreadyReleased
    );
    assert_eq!(pair.registry.counts().freed, freed);
}

#[test]
fn identity_report_delivery_enables_exactly_one_decision() {
    let fixture = Fixture::new();
    let mut pair = Pair::new(
        &fixture,
        ffi::TLS1_3_VERSION,
        CaMode::Explicit(vec![&fixture.certificate]),
        StartupExtras::Absent,
        false,
        false,
    );
    pair.handshake().unwrap();
    assert!(pair.peer.is_some());
    assert!(!pair.registry.authorized(pair.id).unwrap());
    pair.registry.accept_identity(pair.id, true, None).unwrap();
    assert!(pair.registry.authorized(pair.id).unwrap());
    assert_eq!(
        pair.registry
            .accept_identity(pair.id, true, None)
            .unwrap_err()
            .code,
        "ERR_TLS_INVALID_STATE"
    );
}

#[test]
fn server_alpn_selector_validates_the_complete_wire_vector() {
    let mut output = std::ptr::null();
    let mut output_len = 0;
    let protocols = b"\x02h2\x08http/1.1";
    let selected = unsafe {
        select_http11(
            std::ptr::null_mut(),
            &mut output,
            &mut output_len,
            protocols.as_ptr(),
            protocols.len().try_into().unwrap(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(selected, ffi::SSL_TLSEXT_ERR_OK);
    assert_eq!(
        unsafe { std::slice::from_raw_parts(output, output_len.into()) },
        b"http/1.1"
    );
    assert!(!offers_http11(b"\x02h2"));
    assert!(!offers_http11(b"\x09http/1.1"));
    assert!(!offers_http11(b"\x08http/1.1\x02x"));
    assert!(!offers_http11(b"\x00"));
}

#[test]
fn root_ranges_share_boundaries_and_reject_backtracking() {
    let bundle = include_bytes!("../../data/tls-roots.der");
    let roots = trust::bundle_slices(bundle).unwrap();
    for pair in roots.windows(2) {
        assert_eq!(pair[0].as_ptr_range().end, pair[1].as_ptr());
    }
    let mut changed = bundle.to_vec();
    changed[12..16].copy_from_slice(&0_u32.to_le_bytes());
    assert!(trust::bundle_slices(&changed).is_err());
}
