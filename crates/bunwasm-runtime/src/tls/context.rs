use super::owned::{self, Kind, Meter, Owned};
use super::trust::{self, Trust};
use super::{Failure, MAX_CERT_LIST, Result};
use bunwasm_crypto_sys::tls as ffi;
use std::rc::Rc;

pub enum CaMode<'a> {
    Default,
    Explicit(Vec<&'a [u8]>),
}

pub struct ContextOptions<'a> {
    pub min_version: u16,
    pub max_version: u16,
    pub ca: CaMode<'a>,
    pub certificate: Option<&'a [u8]>,
    pub key: Option<&'a [u8]>,
}

impl Default for ContextOptions<'_> {
    fn default() -> Self {
        Self {
            min_version: ffi::TLS1_2_VERSION,
            max_version: ffi::TLS1_3_VERSION,
            ca: CaMode::Default,
            certificate: None,
            key: None,
        }
    }
}

pub struct Context {
    pub ssl: Owned<ffi::SslCtx>,
    // SSL_CTX holds a second store reference. This owner releases the final one.
    _store: Owned<ffi::X509Store>,
    _identity: Option<ClientIdentity>,
}

impl Context {
    pub fn new(options: ContextOptions<'_>, trust: &mut Trust, meter: &Rc<Meter>) -> Result<Self> {
        Self::with_method(options, trust, meter, unsafe { ffi::TLS_client_method() })
    }

    #[cfg(all(test, not(target_os = "wasi")))]
    pub(super) fn server(
        options: ContextOptions<'_>,
        trust: &mut Trust,
        meter: &Rc<Meter>,
    ) -> Result<Self> {
        Self::with_method(options, trust, meter, unsafe { ffi::TLS_server_method() })
    }

    fn with_method(
        options: ContextOptions<'_>,
        trust: &mut Trust,
        meter: &Rc<Meter>,
        method: *const ffi::SslMethod,
    ) -> Result<Self> {
        validate(&options)?;
        let ssl = owned::allocated(
            || unsafe { ffi::SSL_CTX_new(method) },
            ffi::SSL_CTX_free,
            Kind::Context,
            meter,
        )?;
        configure(ssl.pointer(), &options)?;
        let store = owned::allocated(
            || unsafe { ffi::X509_STORE_new() },
            ffi::X509_STORE_free,
            Kind::Store,
            meter,
        )?;
        install_trust(store.pointer(), &options.ca, trust, meter)?;
        owned::checked(
            || unsafe { ffi::X509_STORE_up_ref(store.pointer()) },
            "ERR_TLS_TRUST",
            "Unable to retain TLS trust store",
        )?;
        owned::clear();
        unsafe {
            ffi::SSL_CTX_set_cert_store(ssl.pointer(), store.pointer());
        }
        owned::capture();
        let identity = install_identity(ssl.pointer(), options.certificate, options.key, meter)?;
        Ok(Self {
            ssl,
            _store: store,
            _identity: identity,
        })
    }
}

fn validate(options: &ContextOptions<'_>) -> Result<()> {
    let versions = [ffi::TLS1_2_VERSION, ffi::TLS1_3_VERSION];
    if !versions.contains(&options.min_version)
        || !versions.contains(&options.max_version)
        || options.min_version > options.max_version
    {
        return Err(Failure::new(
            "ERR_TLS_INVALID_PROTOCOL_VERSION",
            "TLS requires a valid TLS 1.2 to TLS 1.3 range",
        ));
    }
    if options.certificate.is_some() != options.key.is_some() {
        return Err(Failure::new(
            "ERR_TLS_CLIENT_IDENTITY",
            "TLS client certificate and key must be supplied together",
        ));
    }
    Ok(())
}

fn configure(context: *mut ffi::SslCtx, options: &ContextOptions<'_>) -> Result<()> {
    owned::checked(
        || unsafe { ffi::SSL_CTX_set_min_proto_version(context, options.min_version) },
        "ERR_TLS_INVALID_PROTOCOL_VERSION",
        "Invalid minimum TLS version",
    )?;
    owned::checked(
        || unsafe { ffi::SSL_CTX_set_max_proto_version(context, options.max_version) },
        "ERR_TLS_INVALID_PROTOCOL_VERSION",
        "Invalid maximum TLS version",
    )?;
    owned::clear();
    unsafe {
        ffi::SSL_CTX_set_verify(context, ffi::SSL_VERIFY_PEER, None);
        ffi::SSL_CTX_set_verify_depth(context, 16);
        ffi::SSL_CTX_set_max_cert_list(context, MAX_CERT_LIST);
    }
    owned::capture();
    Ok(())
}

fn install_trust(
    store: *mut ffi::X509Store,
    mode: &CaMode<'_>,
    trust: &mut Trust,
    meter: &Rc<Meter>,
) -> Result<()> {
    let CaMode::Explicit(inputs) = mode else {
        return trust.defaults(store);
    };
    let mut size = 0usize;
    for input in inputs {
        size = size
            .checked_add(input.len())
            .ok_or_else(trust::invalid_material)?;
        if size > trust::MAX_MATERIAL {
            return Err(trust::invalid_material());
        }
        trust::add_certificates(store, &trust::certificates(input, meter)?)?;
    }
    Ok(())
}

struct ClientIdentity {
    _certificates: Vec<Owned<ffi::Certificate>>,
    _key: Owned<ffi::Key>,
}

fn install_identity(
    context: *mut ffi::SslCtx,
    certificate: Option<&[u8]>,
    key: Option<&[u8]>,
    meter: &Rc<Meter>,
) -> Result<Option<ClientIdentity>> {
    let Some(certificate) = certificate else {
        return Ok(None);
    };
    let key = key.ok_or_else(trust::invalid_material)?;
    let certificates = trust::certificates(certificate, meter)?;
    if certificates.len() > 17 || certificate.len() > MAX_CERT_LIST {
        return Err(trust::invalid_material());
    }
    let leaf = certificates.first().ok_or_else(trust::invalid_material)?;
    owned::checked(
        || unsafe { ffi::SSL_CTX_use_certificate(context, leaf.pointer()) },
        "ERR_TLS_CLIENT_IDENTITY",
        "Invalid TLS client certificate",
    )?;
    for certificate in &certificates[1..] {
        owned::checked(
            || unsafe { ffi::SSL_CTX_add1_chain_cert(context, certificate.pointer()) },
            "ERR_TLS_CLIENT_IDENTITY",
            "Invalid TLS client certificate chain",
        )?;
    }
    let key = private_key(key, meter)?;
    owned::checked(
        || unsafe { ffi::SSL_CTX_use_PrivateKey(context, key.pointer()) },
        "ERR_TLS_CLIENT_IDENTITY",
        "Invalid TLS client private key",
    )?;
    owned::checked(
        || unsafe { ffi::SSL_CTX_check_private_key(context) },
        "ERR_TLS_CLIENT_IDENTITY",
        "TLS client certificate and key do not match",
    )?;
    Ok(Some(ClientIdentity {
        _certificates: certificates,
        _key: key,
    }))
}

fn private_key(input: &[u8], meter: &Rc<Meter>) -> Result<Owned<ffi::Key>> {
    if input.is_empty() || input.len() > trust::MAX_MATERIAL {
        return Err(trust::invalid_material());
    }
    let input = Secret(input.to_vec());
    if input.0.first() == Some(&0x30) {
        return der_key(&input.0, meter);
    }
    let text = std::str::from_utf8(&input.0)
        .map_err(|_| trust::invalid_material())?
        .trim();
    validate_key_pem(text)?;
    let decoded = trust::pem_der(text.as_bytes(), meter)?;
    der_key(decoded.bytes(), meter)
}

fn validate_key_pem(text: &str) -> Result<()> {
    let label = ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"]
        .into_iter()
        .find(|label| text.starts_with(&format!("-----BEGIN {label}-----")))
        .ok_or_else(trust::invalid_material)?;
    let end = format!("-----END {label}-----");
    let position = text.find(&end).ok_or_else(trust::invalid_material)? + end.len();
    if position != text.len() {
        return Err(trust::invalid_material());
    }
    Ok(())
}

fn der_key(input: &[u8], meter: &Rc<Meter>) -> Result<Owned<ffi::Key>> {
    let mut cursor = input.as_ptr();
    let length = input
        .len()
        .try_into()
        .map_err(|_| trust::invalid_material())?;
    let key = owned::allocated(
        || unsafe { ffi::d2i_AutoPrivateKey(std::ptr::null_mut(), &mut cursor, length) },
        ffi::EVP_PKEY_free,
        Kind::Key,
        meter,
    )?;
    if cursor != input.as_ptr().wrapping_add(input.len()) {
        return Err(trust::invalid_material());
    }
    Ok(key)
}

struct Secret(Vec<u8>);
impl Drop for Secret {
    fn drop(&mut self) {
        unsafe {
            ffi::OPENSSL_cleanse(self.0.as_mut_ptr().cast(), self.0.len());
        }
    }
}
