use super::{
    Allowance, CaMode, ConnectionId, ConnectionOptions, ContextId, ContextOptions, Counts, Event,
    Failure, Outcome, PeerInfo, Release, SharedRegistry, Step, TlsRegistry, VerifyMode, Wait,
};
use crate::data::{Args, NativeError, NativeResult, Record, Val};
use crate::natives::Table;

impl From<Failure> for NativeError {
    fn from(failure: Failure) -> Self {
        NativeError::error(failure.message).prop("code", failure.code)
    }
}

pub fn install(table: &mut Table, registry: SharedRegistry) {
    let create = registry.clone();
    table.add("tlsCreateContext", move |args| {
        create_context(args, &mut create.borrow_mut())
    });
    let create = registry.clone();
    table.add("tlsCreateConnection", move |args| {
        create_connection(args, &mut create.borrow_mut())
    });
    let step = registry.clone();
    table.add("tlsStep", move |args| drive(args, &mut step.borrow_mut()));
    let identity = registry.clone();
    table.add("tlsAcceptIdentity", move |args| {
        accept_identity(args, &mut identity.borrow_mut())
    });
    let inspect = registry.clone();
    table.add("tlsInspect", move |args| {
        inspect_connection(args, &inspect.borrow())
    });
    let dispose_registry = registry.clone();
    table.add("tlsDispose", move |args| {
        dispose(args, &mut dispose_registry.borrow_mut())
    });
    table.add("tlsRelease", move |args| {
        release(args, &mut registry.borrow_mut())
    });
}

fn dispose(args: Args<'_>, registry: &mut TlsRegistry) -> NativeResult {
    if !args.0.is_empty() {
        return Err(argument("TLS disposal does not accept arguments"));
    }
    registry.dispose();
    Ok(Val::Undefined)
}

fn create_context(args: Args<'_>, registry: &mut TlsRegistry) -> NativeResult {
    let fields = object(args.get(0))?;
    known(fields, &["minVersion", "maxVersion", "ca", "cert", "key"])?;
    let ca = match field(fields, "ca") {
        Val::Undefined => CaMode::Default,
        Val::Bytes(bytes) => CaMode::Explicit(vec![bytes]),
        Val::Array(inputs) => CaMode::Explicit(
            inputs
                .iter()
                .map(bytes)
                .collect::<std::result::Result<_, _>>()?,
        ),
        _ => {
            return Err(argument(
                "TLS ca must be a Uint8Array or an array of Uint8Arrays",
            ));
        }
    };
    let options = ContextOptions {
        min_version: version(
            field(fields, "minVersion"),
            bunwasm_crypto_sys::tls::TLS1_2_VERSION,
        )?,
        max_version: version(
            field(fields, "maxVersion"),
            bunwasm_crypto_sys::tls::TLS1_3_VERSION,
        )?,
        ca,
        certificate: optional_bytes(field(fields, "cert"))?,
        key: optional_bytes(field(fields, "key"))?,
    };
    let id = registry.create_context(options)?;
    Ok(Record::new()
        .set("id", id.number())
        .set("warning", optional_text(registry.take_warning()))
        .into())
}

fn create_connection(args: Args<'_>, registry: &mut TlsRegistry) -> NativeResult {
    let context = ContextId::parse(number(args.get(0))?)?;
    let fields = object(args.get(1))?;
    known(fields, &["servername", "alpn", "rejectUnauthorized"])?;
    let options = ConnectionOptions {
        servername: optional_string(field(fields, "servername"))?,
        alpn: optional_bytes(field(fields, "alpn"))?.unwrap_or(&[]),
        verify: if boolean(field(fields, "rejectUnauthorized"), true)? {
            VerifyMode::Required
        } else {
            VerifyMode::ReportOnly
        },
    };
    Ok(registry
        .create_connection(context, options)?
        .number()
        .into())
}

fn drive(args: Args<'_>, registry: &mut TlsRegistry) -> NativeResult {
    let id = ConnectionId::parse(number(args.get(0))?)?;
    let event = parse_event(args.get(1))?;
    let allowances = object(args.get(2))?;
    known(allowances, &["plaintext", "ciphertext"])?;
    let allowances = Allowance {
        plaintext: allowance(field(allowances, "plaintext"))?,
        ciphertext: allowance(field(allowances, "ciphertext"))?,
    };
    Ok(step_value(registry.step(id, event, allowances)?))
}

fn parse_event(value: &Val) -> std::result::Result<Event<'_>, NativeError> {
    let fields = object(value)?;
    known(fields, &["kind", "data"])?;
    let kind = string(field(fields, "kind"))?;
    match kind {
        "ciphertext" => Ok(Event::Ciphertext(bytes(field(fields, "data"))?)),
        "plaintext" => Ok(Event::Plaintext(bytes(field(fields, "data"))?)),
        "poll" | "transport-eof" | "shutdown-write" => {
            event_without_data(kind, field(fields, "data"))
        }
        _ => Err(argument("Invalid TLS step event kind")),
    }
}

fn event_without_data<'a>(kind: &str, data: &Val) -> std::result::Result<Event<'a>, NativeError> {
    if !matches!(data, Val::Undefined) {
        return Err(argument("TLS control events cannot contain data"));
    }
    match kind {
        "poll" => Ok(Event::Poll),
        "transport-eof" => Ok(Event::TransportEof),
        "shutdown-write" => Ok(Event::ShutdownWrite),
        _ => Err(argument("Invalid TLS control event")),
    }
}

fn accept_identity(args: Args<'_>, registry: &mut TlsRegistry) -> NativeResult {
    let id = ConnectionId::parse(number(args.get(0))?)?;
    let fields = object(args.get(1))?;
    known(fields, &["accepted", "code"])?;
    let Val::Bool(accepted) = field(fields, "accepted") else {
        return Err(argument("TLS identity decision requires accepted"));
    };
    registry.accept_identity(id, *accepted, optional_string(field(fields, "code"))?)?;
    Ok(Val::Undefined)
}

fn inspect_connection(args: Args<'_>, registry: &TlsRegistry) -> NativeResult {
    let id = ConnectionId::parse(number(args.get(0))?)?;
    let requested = match args.get(1) {
        Val::Undefined => "peer",
        value => string(value)?,
    };
    if requested != "peer" {
        return Err(argument("Invalid TLS metadata request"));
    }
    Ok(Record::new()
        .set("peer", peer_value(registry.inspect(id)?))
        .set("authorized", registry.authorized(id)?)
        .set(
            "authorizationError",
            optional_text(registry.authorization_error(id)?),
        )
        .into())
}

fn release(args: Args<'_>, registry: &mut TlsRegistry) -> NativeResult {
    let number = number(args.get(1))?;
    let released = match args.str(0)? {
        "context" => registry.release_context(ContextId::parse(number)?)?,
        "connection" => registry.release_connection(ConnectionId::parse(number)?)?,
        _ => return Err(argument("TLS release requires a typed object kind")),
    };
    let counts = registry.counts();
    Ok(Record::new()
        .set("released", released == Release::Released)
        .set("contexts", counts.contexts as f64)
        .set("connections", counts.connections as f64)
        .set("owned", counts_value(counts.owned))
        .set("freed", counts_value(counts.freed))
        .into())
}

fn step_value(step: Step) -> Val {
    let mut result = Record::new()
        .set("acceptedCiphertext", step.accepted_ciphertext as f64)
        .set("consumedCiphertext", step.consumed_ciphertext as f64)
        .set("acceptedPlaintext", step.accepted_plaintext as f64)
        .set("committedPlaintext", step.committed_plaintext as f64)
        .set("pendingPlaintext", step.pending_plaintext as f64)
        .set("ciphertext", step.ciphertext)
        .set("plaintext", step.plaintext)
        .set("ciphertextStart", step.ciphertext_start as f64)
        .set("ciphertextEnd", step.ciphertext_end as f64)
        .set("inputCapacity", step.input_capacity as f64)
        .set("readClosed", step.read_closed)
        .set("writeClosed", step.write_closed);
    if let Some(end) = step.write_ciphertext_end {
        result.push("writeCiphertextEnd", end as f64);
    }
    if let Some(end) = step.shutdown_ciphertext_end {
        result.push("shutdownCiphertextEnd", end as f64);
    }
    match step.outcome {
        Outcome::Progress(wait) => {
            result.push("kind", "progress");
            result.push("wait", wait_name(wait));
        }
        Outcome::Wait(wait) => {
            result.push("kind", "wait");
            result.push("wait", wait_name(wait));
        }
        Outcome::VerificationRequired(peer) => {
            result.push("kind", "verification-required");
            result.push("peer", peer_value(peer));
        }
        Outcome::Failed(failure) => {
            result.push("kind", "failed");
            result.push("error", failure_value(failure));
        }
        Outcome::Closed => result.push("kind", "closed"),
    }
    result.into()
}

fn peer_value(peer: PeerInfo) -> Val {
    let alpn = if peer.alpn.is_empty() {
        Val::Bool(false)
    } else {
        Val::Bytes(peer.alpn)
    };
    Record::new()
        .set("protocol", peer.protocol)
        .set("cipher", peer.cipher)
        .set("alpn", alpn)
        .set("verifyResult", peer.verify_result as f64)
        .set("chainVerified", peer.verify_result == 0)
        .set(
            "authorizationError",
            optional_text(peer.authorization_error),
        )
        .set(
            "certificates",
            Val::Array(peer.certificates.into_iter().map(Val::Bytes).collect()),
        )
        .into()
}

fn failure_value(failure: Failure) -> Val {
    let codes = failure.diagnostics.codes[..failure.diagnostics.len]
        .iter()
        .map(|code| Val::from(*code))
        .collect();
    Record::new()
        .set("code", failure.code)
        .set("message", failure.message)
        .set("libraryCodes", Val::Array(codes))
        .into()
}

fn counts_value(counts: Counts) -> Val {
    Record::new()
        .set("contexts", counts.contexts as f64)
        .set("sessions", counts.sessions as f64)
        .set("bios", counts.bios as f64)
        .set("stores", counts.stores as f64)
        .set("certificates", counts.certificates as f64)
        .set("keys", counts.keys as f64)
        .set("rootSets", counts.root_sets as f64)
        .into()
}

fn wait_name(wait: Wait) -> &'static str {
    match wait {
        Wait::Ciphertext => "ciphertext",
        Wait::Output => "output",
        Wait::ReadAllowance => "read-allowance",
        Wait::Identity => "identity",
        Wait::Poll => "poll",
    }
}

fn optional_text(text: Option<&str>) -> Val {
    text.map_or(Val::Bool(false), Val::from)
}
fn argument(message: &'static str) -> NativeError {
    NativeError::type_error(message).prop("code", "ERR_INVALID_ARG_VALUE")
}
fn object(value: &Val) -> std::result::Result<&[(String, Val)], NativeError> {
    match value {
        Val::Object(fields) => Ok(fields),
        _ => Err(argument("TLS options must be a plain object")),
    }
}
fn known(fields: &[(String, Val)], names: &[&str]) -> std::result::Result<(), NativeError> {
    if fields.iter().any(|(key, _)| !names.contains(&key.as_str())) {
        return Err(argument("Unsupported TLS native option"));
    }
    for (index, (key, _)) in fields.iter().enumerate() {
        if fields[index + 1..].iter().any(|(other, _)| other == key) {
            return Err(argument("Duplicate TLS native option"));
        }
    }
    Ok(())
}
fn field<'a>(fields: &'a [(String, Val)], name: &str) -> &'a Val {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map_or(&Val::Undefined, |(_, value)| value)
}
fn bytes(value: &Val) -> std::result::Result<&[u8], NativeError> {
    match value {
        Val::Bytes(input) => Ok(input),
        _ => Err(argument("TLS bytes must be a Uint8Array")),
    }
}
fn optional_bytes(value: &Val) -> std::result::Result<Option<&[u8]>, NativeError> {
    match value {
        Val::Undefined => Ok(None),
        _ => bytes(value).map(Some),
    }
}
fn string(value: &Val) -> std::result::Result<&str, NativeError> {
    match value {
        Val::Str(text) => Ok(text),
        _ => Err(argument("TLS value must be a string")),
    }
}
fn optional_string(value: &Val) -> std::result::Result<Option<&str>, NativeError> {
    match value {
        Val::Undefined => Ok(None),
        _ => string(value).map(Some),
    }
}
fn boolean(value: &Val, default: bool) -> std::result::Result<bool, NativeError> {
    match value {
        Val::Undefined => Ok(default),
        Val::Bool(value) => Ok(*value),
        _ => Err(argument("TLS flag must be a boolean")),
    }
}
fn number(value: &Val) -> std::result::Result<f64, NativeError> {
    match value {
        Val::Num(number) => Ok(*number),
        _ => Err(argument("TLS ID must be a safe integer")),
    }
}
fn allowance(value: &Val) -> std::result::Result<usize, NativeError> {
    let number = number(value)?;
    if !number.is_finite()
        || number < 0.0
        || number.fract() != 0.0
        || number > super::MAX_BATCH as f64
    {
        return Err(argument("Invalid TLS output allowance"));
    }
    Ok(number as usize)
}
fn version(value: &Val, default: u16) -> std::result::Result<u16, NativeError> {
    match value {
        Val::Undefined => Ok(default),
        Val::Str(value) if value == "TLSv1.2" => Ok(bunwasm_crypto_sys::tls::TLS1_2_VERSION),
        Val::Str(value) if value == "TLSv1.3" => Ok(bunwasm_crypto_sys::tls::TLS1_3_VERSION),
        _ => Err(argument("TLS version must be TLSv1.2 or TLSv1.3")),
    }
}
