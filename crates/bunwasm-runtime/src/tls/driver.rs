use super::context::Context;
use super::owned::{self, Meter, Session};
use super::{Failure, MAX_BATCH, MAX_CERT_LIST, MAX_PLAINTEXT, Result};
use bunwasm_crypto_sys::tls as ffi;
use std::ffi::{CStr, CString};
use std::net::IpAddr;
use std::rc::Rc;

const MAX_OPERATIONS: usize = 32;
const MAX_TURN_BYTES: usize = 256 * 1024;
const MAX_COUNTER: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VerifyMode {
    Required,
    ReportOnly,
}

pub struct ConnectionOptions<'a> {
    pub servername: Option<&'a str>,
    pub alpn: &'a [u8],
    pub verify: VerifyMode,
}

impl Default for ConnectionOptions<'_> {
    fn default() -> Self {
        Self {
            servername: None,
            alpn: &[],
            verify: VerifyMode::Required,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Allowance {
    pub plaintext: usize,
    pub ciphertext: usize,
}

impl Allowance {
    pub fn validate(self) -> Result<Self> {
        if self.plaintext > MAX_BATCH || self.ciphertext > MAX_BATCH {
            return Err(Failure::new(
                "ERR_TLS_LIMIT",
                "TLS output allowance exceeds the batch limit",
            ));
        }
        Ok(self)
    }
}

pub enum Event<'a> {
    Poll,
    Ciphertext(&'a [u8]),
    Plaintext(&'a [u8]),
    TransportEof,
    ShutdownWrite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    Ciphertext,
    Output,
    ReadAllowance,
    Identity,
    Poll,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PeerInfo {
    pub protocol: String,
    pub cipher: String,
    pub alpn: Vec<u8>,
    pub verify_result: i64,
    pub authorization_error: Option<&'static str>,
    pub certificates: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Progress(Wait),
    Wait(Wait),
    VerificationRequired(PeerInfo),
    Failed(Failure),
    Closed,
}

#[derive(Clone, Debug)]
pub struct Step {
    pub outcome: Outcome,
    pub accepted_ciphertext: usize,
    pub consumed_ciphertext: usize,
    pub accepted_plaintext: usize,
    pub committed_plaintext: usize,
    pub ciphertext: Vec<u8>,
    pub plaintext: Vec<u8>,
    pub ciphertext_start: u64,
    pub ciphertext_end: u64,
    pub write_ciphertext_end: Option<u64>,
    pub shutdown_ciphertext_end: Option<u64>,
    pub input_capacity: usize,
    pub pending_plaintext: usize,
    pub read_closed: bool,
    pub write_closed: bool,
}

impl Step {
    fn new(emitted: u64) -> Self {
        Self {
            outcome: Outcome::Wait(Wait::Poll),
            accepted_ciphertext: 0,
            consumed_ciphertext: 0,
            accepted_plaintext: 0,
            committed_plaintext: 0,
            ciphertext: Vec::new(),
            plaintext: Vec::new(),
            ciphertext_start: emitted,
            ciphertext_end: emitted,
            write_ciphertext_end: None,
            shutdown_ciphertext_end: None,
            input_capacity: 0,
            pending_plaintext: 0,
            read_closed: false,
            write_closed: false,
        }
    }

    fn progressed(&self) -> bool {
        self.accepted_ciphertext != 0
            || self.consumed_ciphertext != 0
            || self.accepted_plaintext != 0
            || self.committed_plaintext != 0
            || !self.ciphertext.is_empty()
            || !self.plaintext.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Handshaking,
    Verifying,
    Open,
    Failed(Failure),
    Closed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadHalf {
    Open,
    Eof,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriteHalf {
    Open,
    Requested,
    Sent(u64),
}

enum Pending {
    None,
    Write(WriteRetry),
    ReadWantWrite,
    Shutdown,
}

struct WriteRetry {
    bytes: Box<[u8]>,
    offset: usize,
}

impl Drop for WriteRetry {
    fn drop(&mut self) {
        unsafe {
            ffi::OPENSSL_cleanse(self.bytes.as_mut_ptr().cast(), self.bytes.len());
        }
    }
}

pub struct Connection {
    session: Option<Session>,
    context: Option<Rc<Context>>,
    phase: Phase,
    pending: Pending,
    read: ReadHalf,
    write: WriteHalf,
    transport_eof: bool,
    emitted: u64,
    discarded_input: usize,
    verify: VerifyMode,
    identity_report: Option<PeerInfo>,
    authorized: bool,
    authorization_error: Option<&'static str>,
}

impl Connection {
    pub fn new(
        context: Rc<Context>,
        options: ConnectionOptions<'_>,
        meter: &Rc<Meter>,
    ) -> Result<Self> {
        validate_alpn(options.alpn)?;
        let servername = sni_name(options.servername)?;
        usable_time()?;
        let session = Session::new(context.ssl.pointer(), meter)?;
        configure(&session, &options, servername.as_deref())?;
        Ok(Self {
            session: Some(session),
            context: Some(context),
            phase: Phase::Handshaking,
            pending: Pending::None,
            read: ReadHalf::Open,
            write: WriteHalf::Open,
            transport_eof: false,
            emitted: 0,
            discarded_input: 0,
            verify: options.verify,
            identity_report: None,
            authorized: false,
            authorization_error: None,
        })
    }

    #[cfg(all(test, not(target_os = "wasi")))]
    pub(super) fn small_bio(
        context: Rc<Context>,
        options: ConnectionOptions<'_>,
        meter: &Rc<Meter>,
        capacity: usize,
    ) -> Result<Self> {
        let servername = sni_name(options.servername)?;
        let session = Session::with_capacity(context.ssl.pointer(), meter, capacity)?;
        configure(&session, &options, servername.as_deref())?;
        let mut connection = Self::new(context, options, meter)?;
        connection.session = Some(session);
        Ok(connection)
    }

    #[cfg(all(test, not(target_os = "wasi")))]
    pub(super) fn set_test_verify_time(&mut self, time: i64) {
        assert_eq!(self.phase, Phase::Handshaking);
        unsafe {
            ffi::X509_VERIFY_PARAM_set_time_posix(ffi::SSL_get0_param(self.ssl()), time);
        }
    }

    #[cfg(all(test, not(target_os = "wasi")))]
    pub(super) fn pending_write_pointer(&self) -> Option<(*const u8, usize)> {
        let Pending::Write(retry) = &self.pending else {
            return None;
        };
        Some((
            retry.bytes[retry.offset..].as_ptr(),
            retry.bytes.len() - retry.offset,
        ))
    }

    pub fn step(&mut self, event: Event<'_>, allowance: Allowance) -> Result<Step> {
        let allowance = allowance.validate()?;
        let mut step = Step::new(self.emitted);
        if self.terminal() {
            return Ok(self.finish(step, Wait::Poll, false));
        }
        self.validate_event(&event)?;
        let previous_input = self.input_pending();
        let previous_phase = self.phase.clone();
        if let Err(failure) = self.apply_event(event, &mut step) {
            self.fail(failure);
        }
        let wait = self.drive(allowance, &mut step);
        let remaining = if matches!(self.phase, Phase::Failed(_)) {
            self.discarded_input
        } else {
            self.input_pending()
        };
        step.consumed_ciphertext = previous_input + step.accepted_ciphertext
            - remaining.min(previous_input + step.accepted_ciphertext);
        let transitioned = self.phase != previous_phase || step.shutdown_ciphertext_end.is_some();
        Ok(self.finish(step, wait, transitioned))
    }

    pub fn accept_identity(&mut self, accepted: bool, failure_code: Option<&str>) -> Result<()> {
        if self.phase != Phase::Verifying || self.identity_report.is_some() {
            return Err(Failure::new(
                "ERR_TLS_INVALID_STATE",
                "TLS identity decision is not pending",
            ));
        }
        if !accepted {
            let code = identity_failure_code(failure_code);
            self.fail(Failure::new(code, "TLS peer identity rejected"));
            return Ok(());
        }
        if self.verify == VerifyMode::Required && self.authorization_error.is_some() {
            self.fail(Failure::new(
                "ERR_TLS_CERTIFICATE",
                "TLS certificate verification failed",
            ));
            return Ok(());
        }
        self.authorized = self.authorization_error.is_none();
        self.phase = Phase::Open;
        Ok(())
    }

    pub fn inspect(&self) -> Result<PeerInfo> {
        if !matches!(self.phase, Phase::Verifying | Phase::Open | Phase::Closed) {
            return Err(Failure::new(
                "ERR_TLS_INVALID_STATE",
                "TLS handshake metadata is unavailable",
            ));
        }
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| Failure::new("ERR_TLS_INVALID_STATE", "TLS connection is closed"))?;
        peer_info(session)
    }

    pub fn authorized(&self) -> bool {
        self.authorized
    }
    pub fn authorization_error(&self) -> Option<&'static str> {
        self.authorization_error
    }

    fn terminal(&self) -> bool {
        matches!(self.phase, Phase::Failed(_) | Phase::Closed)
    }

    fn validate_event(&self, event: &Event<'_>) -> Result<()> {
        match event {
            Event::Ciphertext(input) if input.len() > MAX_BATCH => Err(Failure::new(
                "ERR_TLS_LIMIT",
                "TLS ciphertext input exceeds the batch limit",
            )),
            Event::Ciphertext(_) if self.transport_eof || self.read == ReadHalf::Eof => {
                Err(Failure::new("ERR_TLS_INVALID_STATE", "TLS input is closed"))
            }
            Event::Plaintext(input) if input.len() > MAX_PLAINTEXT => Err(Failure::new(
                "ERR_TLS_LIMIT",
                "TLS plaintext input exceeds one record",
            )),
            Event::Plaintext(_) if self.phase != Phase::Open => Err(Failure::new(
                "ERR_TLS_VERIFICATION_PENDING",
                "TLS application I/O requires an accepted identity",
            )),
            Event::Plaintext(_) if self.write != WriteHalf::Open => Err(Failure::new(
                "ERR_TLS_WRITE_CLOSED",
                "TLS write side is closed",
            )),
            Event::ShutdownWrite if self.phase != Phase::Open => Err(Failure::new(
                "ERR_TLS_VERIFICATION_PENDING",
                "TLS shutdown requires an accepted identity",
            )),
            _ => Ok(()),
        }
    }

    fn apply_event(&mut self, event: Event<'_>, step: &mut Step) -> Result<()> {
        match event {
            Event::Poll => Ok(()),
            Event::Ciphertext(input) => self.feed(input, step),
            Event::Plaintext(input) => {
                if !matches!(self.pending, Pending::None) || input.is_empty() {
                    return Ok(());
                }
                self.pending = Pending::Write(WriteRetry {
                    bytes: input.into(),
                    offset: 0,
                });
                step.accepted_plaintext = input.len();
                Ok(())
            }
            Event::TransportEof => self.eof(),
            Event::ShutdownWrite => {
                if self.write == WriteHalf::Open {
                    self.write = WriteHalf::Requested;
                }
                Ok(())
            }
        }
    }

    fn feed(&mut self, input: &[u8], step: &mut Step) -> Result<()> {
        let network = self.network();
        let capacity = unsafe { ffi::BIO_ctrl_get_write_guarantee(network) };
        let amount = input.len().min(capacity);
        if amount == 0 {
            return Ok(());
        }
        owned::clear();
        let result = unsafe { ffi::BIO_write(network, input.as_ptr().cast(), amount as i32) };
        let errors = owned::capture();
        if result <= 0 || result as usize > amount {
            return Err(Failure::with_errors(
                "ERR_TLS_BIO",
                "TLS ciphertext input failed",
                errors,
            ));
        }
        step.accepted_ciphertext = result as usize;
        Ok(())
    }

    fn eof(&mut self) -> Result<()> {
        if self.transport_eof {
            return Ok(());
        }
        owned::checked(
            || unsafe { ffi::BIO_shutdown_wr(self.network()) },
            "ERR_TLS_BIO",
            "TLS transport EOF failed",
        )?;
        self.transport_eof = true;
        Ok(())
    }

    fn drive(&mut self, allowance: Allowance, step: &mut Step) -> Wait {
        for _ in 0..MAX_OPERATIONS {
            if self.terminal() {
                return Wait::Poll;
            }
            if let Err(failure) = self.drain(allowance.ciphertext, step) {
                self.fail(failure);
                return Wait::Poll;
            }
            if self.output_pending() != 0 {
                return Wait::Output;
            }
            if step.ciphertext.len() + step.plaintext.len() + step.accepted_ciphertext
                >= MAX_TURN_BYTES
            {
                return Wait::Poll;
            }
            let before = self.progress_marker(step);
            let operation = self.operation(
                allowance.plaintext.saturating_sub(step.plaintext.len()),
                step,
            );
            let wait = match operation {
                Ok(wait) => wait,
                Err(failure) => {
                    self.fail(failure);
                    return Wait::Poll;
                }
            };
            if let Err(failure) = self.drain(allowance.ciphertext, step) {
                self.fail(failure);
                return Wait::Poll;
            }
            if self.phase == Phase::Verifying {
                return Wait::Identity;
            }
            if self.progress_marker(step) == before {
                return wait;
            }
            if wait == Wait::ReadAllowance || self.both_closed() {
                return wait;
            }
        }
        Wait::Poll
    }

    fn progress_marker(
        &self,
        step: &Step,
    ) -> (usize, usize, usize, usize, u64, Phase, WriteHalf, ReadHalf) {
        (
            self.input_pending(),
            self.output_pending(),
            step.plaintext.len(),
            step.committed_plaintext,
            self.emitted,
            self.phase.clone(),
            self.write,
            self.read,
        )
    }

    fn operation(&mut self, read_allowance: usize, step: &mut Step) -> Result<Wait> {
        match self.phase {
            Phase::Handshaking => return self.handshake(),
            Phase::Verifying => return Ok(Wait::Identity),
            Phase::Failed(_) | Phase::Closed => return Ok(Wait::Poll),
            Phase::Open => {}
        }
        if matches!(self.pending, Pending::Write(_)) {
            return self.write_pending(step);
        }
        if matches!(self.pending, Pending::ReadWantWrite) {
            return self.read_pending(read_allowance, step);
        }
        if self.write == WriteHalf::Requested || matches!(self.pending, Pending::Shutdown) {
            return self.shutdown(step);
        }
        self.read_pending(read_allowance, step)
    }

    fn handshake(&mut self) -> Result<Wait> {
        usable_time()?;
        let ssl = self.ssl();
        let call = ssl_call(ssl, || unsafe { ffi::SSL_do_handshake(ssl) });
        if call.result != 1 {
            return self.classify(call);
        }
        let report = peer_info(self.session.as_ref().expect("live TLS session"))?;
        if self.verify == VerifyMode::Required && report.verify_result != 0 {
            return Err(Failure::new(
                verification_code(report.verify_result),
                "TLS certificate verification failed",
            ));
        }
        self.authorization_error = report.authorization_error;
        self.identity_report = Some(report);
        self.phase = Phase::Verifying;
        Ok(Wait::Identity)
    }

    fn write_pending(&mut self, step: &mut Step) -> Result<Wait> {
        let ssl = self.ssl();
        let Pending::Write(retry) = &self.pending else {
            unreachable!()
        };
        let call = ssl_call(ssl, || unsafe {
            ffi::SSL_write(
                ssl,
                retry.bytes[retry.offset..].as_ptr().cast(),
                (retry.bytes.len() - retry.offset) as i32,
            )
        });
        if call.result <= 0 {
            return self.classify(call);
        }
        let committed = call.result as usize;
        if committed > retry.bytes.len() - retry.offset {
            return Err(Failure::new(
                "ERR_TLS_INTERNAL",
                "TLS write returned an invalid count",
            ));
        }
        step.committed_plaintext += committed;
        step.write_ciphertext_end = Some(self.output_fence()?);
        let Pending::Write(retry) = &mut self.pending else {
            unreachable!()
        };
        retry.offset += committed;
        if retry.offset == retry.bytes.len() {
            self.pending = Pending::None;
        }
        Ok(Wait::Poll)
    }

    fn read_pending(&mut self, allowance: usize, step: &mut Step) -> Result<Wait> {
        if self.read == ReadHalf::Eof {
            return Ok(Wait::Poll);
        }
        if allowance == 0 {
            return Ok(Wait::ReadAllowance);
        }
        let amount = allowance.min(MAX_PLAINTEXT);
        let start = step.plaintext.len();
        step.plaintext.resize(start + amount, 0);
        let ssl = self.ssl();
        let call = ssl_call(ssl, || unsafe {
            ffi::SSL_read(
                ssl,
                step.plaintext[start..].as_mut_ptr().cast(),
                amount as i32,
            )
        });
        if call.result > 0 {
            step.plaintext.truncate(start + call.result as usize);
            self.pending = Pending::None;
            return Ok(Wait::Poll);
        }
        step.plaintext.truncate(start);
        if call.error == ffi::SSL_ERROR_ZERO_RETURN {
            self.read = ReadHalf::Eof;
            self.pending = Pending::None;
            return Ok(Wait::Poll);
        }
        self.pending = if call.error == ffi::SSL_ERROR_WANT_WRITE {
            Pending::ReadWantWrite
        } else {
            Pending::None
        };
        self.classify(call)
    }

    fn shutdown(&mut self, step: &mut Step) -> Result<Wait> {
        let ssl = self.ssl();
        let call = ssl_call(ssl, || unsafe { ffi::SSL_shutdown(ssl) });
        if call.result < 0 {
            self.pending = Pending::Shutdown;
            return self.classify(call);
        }
        let fence = self.output_fence()?;
        self.write = WriteHalf::Sent(fence);
        self.pending = Pending::None;
        step.shutdown_ciphertext_end = Some(fence);
        Ok(Wait::Poll)
    }

    fn classify(&self, call: SslCall) -> Result<Wait> {
        match call.error {
            ffi::SSL_ERROR_WANT_READ => Ok(Wait::Ciphertext),
            ffi::SSL_ERROR_WANT_WRITE => Ok(Wait::Output),
            _ => Err(self.protocol_failure(call)),
        }
    }

    fn protocol_failure(&self, call: SslCall) -> Failure {
        let verification = unsafe { ffi::SSL_get_verify_result(self.ssl()) } as i64;
        if verification != 0 && self.phase == Phase::Handshaking {
            return Failure::with_errors(
                verification_code(verification),
                "TLS certificate verification failed",
                call.errors,
            );
        }
        if self.transport_eof && self.read != ReadHalf::Eof {
            let code = if self.phase == Phase::Handshaking {
                "ECONNRESET"
            } else {
                "ERR_TLS_UNEXPECTED_EOF"
            };
            return Failure::with_errors(
                code,
                "TLS transport ended without close-notify",
                call.errors,
            );
        }
        Failure::with_errors(
            "ERR_TLS_PROTOCOL",
            "TLS protocol operation failed",
            call.errors,
        )
    }

    fn drain(&mut self, allowance: usize, step: &mut Step) -> Result<()> {
        let amount = self
            .output_pending()
            .min(allowance.saturating_sub(step.ciphertext.len()));
        if amount == 0 {
            return Ok(());
        }
        let start = step.ciphertext.len();
        step.ciphertext.resize(start + amount, 0);
        owned::clear();
        let result = unsafe {
            ffi::BIO_read(
                self.network(),
                step.ciphertext[start..].as_mut_ptr().cast(),
                amount as i32,
            )
        };
        let errors = owned::capture();
        if result <= 0 || result as usize > amount {
            step.ciphertext.truncate(start);
            return Err(Failure::with_errors(
                "ERR_TLS_BIO",
                "TLS ciphertext output failed",
                errors,
            ));
        }
        step.ciphertext.truncate(start + result as usize);
        self.emitted = self
            .emitted
            .checked_add(result as u64)
            .filter(|total| *total <= MAX_COUNTER)
            .ok_or_else(|| Failure::new("ERR_TLS_LIMIT", "TLS ciphertext counter exhausted"))?;
        Ok(())
    }

    fn output_fence(&self) -> Result<u64> {
        self.emitted
            .checked_add(self.output_pending() as u64)
            .filter(|total| *total <= MAX_COUNTER)
            .ok_or_else(|| Failure::new("ERR_TLS_LIMIT", "TLS ciphertext counter exhausted"))
    }

    fn both_closed(&self) -> bool {
        self.read == ReadHalf::Eof
            && matches!(self.write, WriteHalf::Sent(fence) if self.emitted >= fence)
    }

    fn finish(&mut self, mut step: Step, wait: Wait, transitioned: bool) -> Step {
        step.ciphertext_end = self.emitted;
        step.pending_plaintext = match &self.pending {
            Pending::Write(retry) => retry.bytes.len() - retry.offset,
            _ => 0,
        };
        step.read_closed = self.read == ReadHalf::Eof;
        step.write_closed = matches!(self.write, WriteHalf::Sent(fence) if self.emitted >= fence);
        step.input_capacity = if self.transport_eof || step.read_closed || self.terminal() {
            0
        } else {
            unsafe { ffi::BIO_ctrl_get_write_guarantee(self.network()) }.min(MAX_BATCH)
        };
        if self.both_closed() {
            self.phase = Phase::Closed;
        }
        step.outcome = match &self.phase {
            Phase::Failed(failure) => Outcome::Failed(failure.clone()),
            Phase::Closed => Outcome::Closed,
            Phase::Verifying if self.identity_report.is_some() => {
                Outcome::VerificationRequired(self.identity_report.take().expect("identity report"))
            }
            _ if transitioned || step.progressed() => Outcome::Progress(wait),
            _ => Outcome::Wait(wait),
        };
        step
    }

    fn fail(&mut self, failure: Failure) {
        self.discarded_input = self.input_pending();
        self.phase = Phase::Failed(failure);
        self.identity_report = None;
        self.authorized = false;
        drop(self.session.take());
        self.pending = Pending::None;
        drop(self.context.take());
    }

    fn ssl(&self) -> *mut ffi::Ssl {
        self.session
            .as_ref()
            .expect("live TLS session")
            .ssl
            .pointer()
    }
    fn network(&self) -> *mut ffi::Bio {
        self.session
            .as_ref()
            .expect("live TLS session")
            .network
            .pointer()
    }
    fn input_pending(&self) -> usize {
        self.session.as_ref().map_or(0, |session| unsafe {
            ffi::BIO_ctrl_pending(session.inside)
        })
    }
    fn output_pending(&self) -> usize {
        self.session.as_ref().map_or(0, |session| unsafe {
            ffi::BIO_ctrl_pending(session.network.pointer())
        })
    }
}

struct SslCall {
    result: i32,
    error: i32,
    errors: owned::ErrorStack,
}

fn ssl_call(ssl: *mut ffi::Ssl, call: impl FnOnce() -> i32) -> SslCall {
    owned::clear();
    let result = call();
    // No other BoringSSL call may intervene before SSL_get_error.
    let error = unsafe { ffi::SSL_get_error(ssl, result) };
    let errors = owned::capture();
    SslCall {
        result,
        error,
        errors,
    }
}

fn usable_time() -> Result<()> {
    let usable = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .is_ok_and(|time| time.as_secs() > 0);
    if !usable {
        return Err(Failure::new(
            "ERR_TLS_CLOCK",
            "TLS requires a usable wall clock",
        ));
    }
    Ok(())
}

fn configure(
    session: &Session,
    options: &ConnectionOptions<'_>,
    servername: Option<&CStr>,
) -> Result<()> {
    let ssl = session.ssl.pointer();
    owned::clear();
    unsafe {
        ffi::SSL_set_connect_state(ssl);
        ffi::SSL_set_verify(
            ssl,
            if options.verify == VerifyMode::Required {
                ffi::SSL_VERIFY_PEER
            } else {
                ffi::SSL_VERIFY_NONE
            },
            None,
        );
        ffi::SSL_set_mode(ssl, ffi::SSL_MODE_ENABLE_PARTIAL_WRITE);
    }
    owned::capture();
    if let Some(name) = servername {
        owned::checked(
            || unsafe { ffi::SSL_set_tlsext_host_name(ssl, name.as_ptr()) },
            "ERR_TLS_SNI",
            "Unable to configure TLS server name",
        )?;
    }
    owned::clear();
    let result =
        unsafe { ffi::SSL_set_alpn_protos(ssl, options.alpn.as_ptr(), options.alpn.len()) };
    let errors = owned::capture();
    if result != 0 {
        return Err(Failure::with_errors(
            "ERR_TLS_ALPN",
            "Unable to configure TLS ALPN protocols",
            errors,
        ));
    }
    Ok(())
}

pub fn validate_alpn(protocols: &[u8]) -> Result<()> {
    if protocols.len() > u16::MAX as usize {
        return Err(Failure::new(
            "ERR_TLS_ALPN",
            "TLS ALPN list exceeds the protocol limit",
        ));
    }
    let mut offset = 0;
    while offset < protocols.len() {
        let length = usize::from(protocols[offset]);
        offset += length + 1;
        if length == 0 || offset > protocols.len() {
            return Err(Failure::new(
                "ERR_TLS_ALPN",
                "Invalid TLS ALPN protocol vector",
            ));
        }
    }
    Ok(())
}

pub fn sni_name(name: Option<&str>) -> Result<Option<CString>> {
    let Some(name) = name.filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if name.parse::<IpAddr>().is_ok() {
        return Ok(None);
    }
    let dns = name.strip_suffix('.').unwrap_or(name);
    if dns.len() > 253 || dns.is_empty() || !dns.is_ascii() || !dns.split('.').all(dns_label) {
        return Err(Failure::new(
            "ERR_TLS_SNI",
            "TLS SNI requires a valid ASCII DNS name",
        ));
    }
    CString::new(name)
        .map(Some)
        .map_err(|_| Failure::new("ERR_TLS_SNI", "Invalid TLS server name"))
}

fn dns_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn peer_info(session: &Session) -> Result<PeerInfo> {
    let ssl = session.ssl.pointer();
    let protocol = borrowed_string(unsafe { ffi::SSL_get_version(ssl) })?;
    let cipher = unsafe { ffi::SSL_get_current_cipher(ssl) };
    if cipher.is_null() {
        return Err(Failure::new(
            "ERR_TLS_PROTOCOL",
            "TLS handshake has no negotiated cipher",
        ));
    }
    let cipher = borrowed_string(unsafe { ffi::SSL_CIPHER_get_name(cipher) })?;
    let mut alpn = std::ptr::null();
    let mut length = 0;
    unsafe {
        ffi::SSL_get0_alpn_selected(ssl, &mut alpn, &mut length);
    }
    let alpn = copy_native(alpn, length as usize, 255)?;
    let verify_result = unsafe { ffi::SSL_get_verify_result(ssl) } as i64;
    let certificates = peer_certificates(ssl)?;
    if certificates.is_empty() {
        return Err(Failure::new(
            "ERR_TLS_CERTIFICATE",
            "TLS peer did not provide a certificate",
        ));
    }
    Ok(PeerInfo {
        protocol,
        cipher,
        alpn,
        verify_result,
        authorization_error: (verify_result != 0).then(|| verification_code(verify_result)),
        certificates,
    })
}

fn peer_certificates(ssl: *mut ffi::Ssl) -> Result<Vec<Vec<u8>>> {
    let stack = unsafe { ffi::SSL_get0_peer_certificates(ssl) };
    if stack.is_null() {
        return Ok(Vec::new());
    }
    let count = unsafe { ffi::OPENSSL_sk_num(stack) };
    if count > 17 {
        return Err(Failure::new(
            "ERR_TLS_LIMIT",
            "TLS peer certificate chain exceeds the depth limit",
        ));
    }
    let mut certificates = Vec::with_capacity(count);
    let mut total = 0;
    for index in 0..count {
        let buffer = unsafe { ffi::OPENSSL_sk_value(stack, index) }.cast::<ffi::CryptoBuffer>();
        if buffer.is_null() {
            return Err(Failure::new(
                "ERR_TLS_CERTIFICATE",
                "Invalid TLS peer certificate",
            ));
        }
        let length = unsafe { ffi::CRYPTO_BUFFER_len(buffer) };
        let bytes = copy_native(
            unsafe { ffi::CRYPTO_BUFFER_data(buffer) },
            length,
            MAX_CERT_LIST - total,
        )?;
        total += bytes.len();
        certificates.push(bytes);
    }
    Ok(certificates)
}

fn borrowed_string(pointer: *const std::ffi::c_char) -> Result<String> {
    if pointer.is_null() {
        return Err(Failure::new(
            "ERR_TLS_PROTOCOL",
            "Missing TLS protocol metadata",
        ));
    }
    // These are static library protocol/cipher names, not unbounded peer-supplied strings.
    Ok(unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned())
}

fn copy_native(pointer: *const u8, length: usize, maximum: usize) -> Result<Vec<u8>> {
    if length > maximum || length != 0 && pointer.is_null() {
        return Err(Failure::new(
            "ERR_TLS_LIMIT",
            "TLS metadata exceeds its limit",
        ));
    }
    if length == 0 {
        return Ok(Vec::new());
    }
    Ok(unsafe { std::slice::from_raw_parts(pointer, length) }.to_vec())
}

fn identity_failure_code(code: Option<&str>) -> &'static str {
    match code {
        Some("ERR_TLS_HOSTNAME_REQUIRED") => "ERR_TLS_HOSTNAME_REQUIRED",
        Some("ERR_TLS_IDENTITY_CALLBACK") => "ERR_TLS_IDENTITY_CALLBACK",
        _ => "ERR_TLS_CERT_ALTNAME_INVALID",
    }
}

pub fn verification_code(result: i64) -> &'static str {
    match result {
        9 => "CERT_NOT_YET_VALID",
        10 => "CERT_HAS_EXPIRED",
        18 => "DEPTH_ZERO_SELF_SIGNED_CERT",
        19 => "SELF_SIGNED_CERT_IN_CHAIN",
        20 => "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        21 => "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        22 => "CERT_CHAIN_TOO_LONG",
        23 => "CERT_REVOKED",
        24 => "INVALID_CA",
        26 => "INVALID_PURPOSE",
        62 | 64 => "ERR_TLS_CERT_ALTNAME_INVALID",
        _ => "ERR_TLS_CERTIFICATE",
    }
}

#[cfg(all(test, not(target_os = "wasi")))]
mod retry_tests {
    use super::*;
    use crate::tls::{BIO_CAPACITY, CaMode, ContextOptions, StartupExtras, TlsRegistry};

    fn connection(capacity: usize) -> Connection {
        let mut registry = TlsRegistry::new(StartupExtras::Absent);
        let id = registry
            .create_context(ContextOptions {
                ca: CaMode::Explicit(Vec::new()),
                ..Default::default()
            })
            .unwrap();
        Connection::small_bio(
            registry.contexts.get(id).unwrap().clone(),
            ConnectionOptions::default(),
            &registry.meter,
            capacity,
        )
        .unwrap()
    }

    #[test]
    fn ssl_write_want_read_retries_original_pointer_and_length() {
        let mut connection = connection(BIO_CAPACITY);
        connection.pending = Pending::Write(WriteRetry {
            bytes: b"retry payload".to_vec().into_boxed_slice(),
            offset: 0,
        });
        let pointer = connection.pending_write_pointer().unwrap();
        let mut step = Step::new(0);
        assert_eq!(
            connection.write_pending(&mut step).unwrap(),
            Wait::Ciphertext
        );
        assert_eq!(connection.pending_write_pointer().unwrap(), pointer);
        assert_eq!(
            connection.write_pending(&mut step).unwrap(),
            Wait::Ciphertext
        );
        assert_eq!(connection.pending_write_pointer().unwrap(), pointer);
        assert_eq!(step.committed_plaintext, 0);
    }

    #[test]
    fn ssl_write_want_write_retries_original_pointer_and_length() {
        let mut connection = connection(64);
        connection.pending = Pending::Write(WriteRetry {
            bytes: b"retry payload".to_vec().into_boxed_slice(),
            offset: 0,
        });
        let pointer = connection.pending_write_pointer().unwrap();
        let mut step = Step::new(0);
        assert_eq!(connection.write_pending(&mut step).unwrap(), Wait::Output);
        assert_eq!(connection.pending_write_pointer().unwrap(), pointer);
        assert_eq!(connection.write_pending(&mut step).unwrap(), Wait::Output);
        assert_eq!(connection.pending_write_pointer().unwrap(), pointer);
        assert_eq!(step.committed_plaintext, 0);
    }
}
