use std::ffi::{CStr, c_void};
use std::ptr::{self, NonNull};

use crate::data::{Args, NativeError, NativeResult, Record, Val};
use crate::natives::Table;
use bunwasm_crypto_sys::x509 as ffi;

#[path = "x509_hostname.rs"]
mod hostname;

type Result<T> = std::result::Result<T, NativeError>;

struct ErrorQueue;
impl Drop for ErrorQueue {
    fn drop(&mut self) {
        unsafe {
            ffi::ERR_clear_error();
        }
    }
}

struct Certificate(NonNull<ffi::Certificate>);
impl Drop for Certificate {
    fn drop(&mut self) {
        unsafe {
            ffi::X509_free(self.0.as_ptr());
            ffi::ERR_clear_error();
        }
    }
}

struct Bio(NonNull<ffi::Bio>);
impl Drop for Bio {
    fn drop(&mut self) {
        unsafe {
            ffi::BIO_free(self.0.as_ptr());
        }
    }
}

fn invalid() -> NativeError {
    NativeError::error("Invalid X509 certificate").prop("code", "ERR_CRYPTO_INVALID_STATE")
}

fn pem_or_der(input: &[u8]) -> Result<Vec<u8>> {
    let Ok(text) = std::str::from_utf8(input) else {
        return Ok(input.to_vec());
    };
    let Some((_, body)) = text.split_once("-----BEGIN CERTIFICATE-----") else {
        return Ok(input.to_vec());
    };
    let (body, _) = body
        .split_once("-----END CERTIFICATE-----")
        .ok_or_else(invalid)?;
    let encoded: String = body.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    let der = crate::encoding::base64_decode(&encoded);
    if crate::encoding::base64_encode(&der, false) != encoded {
        return Err(invalid());
    }
    Ok(der)
}

impl Certificate {
    fn parse(input: &[u8]) -> Result<Self> {
        let der = pem_or_der(input)?;
        let mut cursor = der.as_ptr();
        let len = der.len().try_into().map_err(|_| invalid())?;
        let raw = unsafe { ffi::d2i_X509(ptr::null_mut(), &mut cursor, len) };
        let cert = Self(NonNull::new(raw).ok_or_else(invalid)?);
        if cursor != der.as_ptr().wrapping_add(der.len()) {
            return Err(invalid());
        }
        Ok(cert)
    }

    fn p(&self) -> *mut ffi::Certificate {
        self.0.as_ptr()
    }

    fn der(&self) -> Result<Vec<u8>> {
        encoded(|out| unsafe { ffi::i2d_X509(self.p(), out) })
    }

    fn public_key(&self) -> Result<Vec<u8>> {
        let key = unsafe { ffi::X509_get0_pubkey(self.p()) };
        if key.is_null() {
            return Err(
                NativeError::error("Unable to decode certificate public key")
                    .prop("code", "ERR_OSSL_X509_PUBLIC_KEY_DECODE_ERROR"),
            );
        }
        encoded(|out| unsafe { ffi::i2d_PUBKEY(key, out) })
    }

    fn extension(&self, nid: i32) -> Result<Option<String>> {
        let index = unsafe { ffi::X509_get_ext_by_NID(self.p(), nid, -1) };
        if index < 0 {
            return Ok(None);
        }
        let mut critical = 0;
        let decoded =
            unsafe { ffi::X509_get_ext_d2i(self.p(), nid, &mut critical, ptr::null_mut()) };
        let Some(decoded) = NonNull::new(decoded) else {
            return Ok(None);
        };
        let extension = DecodedExtension {
            nid,
            value: decoded,
        };
        let stack = extension.value.as_ptr().cast::<ffi::Stack>();
        let count = unsafe { ffi::OPENSSL_sk_num(stack) };
        let mut output = Vec::new();
        for index in 0..count {
            let entry = unsafe { ffi::OPENSSL_sk_value(stack, index) };
            output.push(extension_entry(nid, entry)?);
        }
        if nid == 85 {
            return Ok(Some(output.join(", ")));
        }
        Ok(Some(output.join("\n") + "\n"))
    }

    fn ca(&self) -> bool {
        let mut critical = 0;
        let constraints =
            unsafe { ffi::X509_get_ext_d2i(self.p(), 87, &mut critical, ptr::null_mut()) }
                .cast::<ffi::BasicConstraints>();
        if constraints.is_null() {
            return false;
        }
        let ca = unsafe { (*constraints).ca != 0 };
        unsafe {
            ffi::BASIC_CONSTRAINTS_free(constraints);
        }
        ca
    }

    fn key_usage(&self) -> Val {
        let mut critical = 0;
        let usage = unsafe { ffi::X509_get_ext_d2i(self.p(), 126, &mut critical, ptr::null_mut()) }
            .cast::<ffi::Stack>();
        if usage.is_null() {
            return Val::Undefined;
        }
        let oids = (0..unsafe { ffi::OPENSSL_sk_num(usage) })
            .map(|index| {
                let oid = unsafe { ffi::OPENSSL_sk_value(usage, index) }.cast::<ffi::Asn1Object>();
                oid_text(oid).into()
            })
            .collect();
        unsafe {
            ffi::EXTENDED_KEY_USAGE_free(usage);
        }
        Val::Array(oids)
    }

    fn metadata(&self) -> NativeResult {
        let raw = self.der()?;
        let subject = unsafe { ffi::X509_get_subject_name(self.p()) };
        let issuer = unsafe { ffi::X509_get_issuer_name(self.p()) };
        let mut algorithm = ptr::null();
        let mut signature = ptr::null();
        unsafe {
            ffi::X509_get0_signature(ptr::null_mut(), &mut algorithm, self.p());
            ffi::X509_ALGOR_get0(&mut signature, ptr::null_mut(), ptr::null_mut(), algorithm);
        }
        let before = printed(|bio| unsafe {
            ffi::ASN1_TIME_print(bio, ffi::X509_get0_notBefore(self.p()))
        })?;
        let after =
            printed(|bio| unsafe { ffi::ASN1_TIME_print(bio, ffi::X509_get0_notAfter(self.p())) })?;
        Ok(Record::new()
            .set("raw", raw.clone())
            .set("subject", name(subject)?)
            .set("issuer", name(issuer)?)
            .set("subjectEntries", name_entries(subject)?)
            .set("issuerEntries", name_entries(issuer)?)
            .set("validFrom", before)
            .set("validTo", after)
            .set("serialNumber", self.serial()?)
            .set("ca", self.ca())
            .set("subjectAltName", self.extension(85)?)
            .set("infoAccess", self.extension(177)?)
            .set("keyUsage", self.key_usage())
            .set("signatureAlgorithm", signature_name(signature))
            .set("signatureAlgorithmOid", oid_text(signature))
            .set("fingerprint", fingerprint("sha1", &raw))
            .set("fingerprint256", fingerprint("sha256", &raw))
            .set("fingerprint512", fingerprint("sha512", &raw))
            .into())
    }

    fn serial(&self) -> Result<String> {
        let bn = unsafe {
            ffi::ASN1_INTEGER_to_BN(ffi::X509_get0_serialNumber(self.p()), ptr::null_mut())
        };
        if bn.is_null() {
            return Err(invalid());
        }
        let hex = unsafe { ffi::BN_bn2hex(bn) };
        unsafe {
            ffi::BN_free(bn);
        }
        if hex.is_null() {
            return Err(invalid());
        }
        let serial = unsafe { CStr::from_ptr(hex) }
            .to_string_lossy()
            .to_ascii_uppercase();
        unsafe {
            ffi::OPENSSL_free(hex.cast());
        }
        Ok(serial)
    }

    fn dns_names(&self) -> Option<Vec<Vec<u8>>> {
        let mut critical = -1;
        let decoded =
            unsafe { ffi::X509_get_ext_d2i(self.p(), 85, &mut critical, ptr::null_mut()) };
        let Some(value) = NonNull::new(decoded) else {
            return (critical == -1).then(Vec::new);
        };
        let extension = DecodedExtension { nid: 85, value };
        let stack = extension.value.as_ptr().cast::<ffi::Stack>();
        let mut names = Vec::new();
        for index in 0..unsafe { ffi::OPENSSL_sk_num(stack) } {
            let entry = unsafe { ffi::OPENSSL_sk_value(stack, index) }.cast::<ffi::GeneralName>();
            let mut kind = -1;
            let name = unsafe { ffi::GENERAL_NAME_get0_value(entry, &mut kind) };
            if kind == 2 {
                names.push(asn1_bytes(name.cast()));
            }
        }
        Some(names)
    }

    fn check_host(&self, host: &[u8], flags: u32) -> Result<Option<String>> {
        let Some(names) = self.dns_names() else {
            return Ok(None);
        };
        if let Some(name) = names
            .iter()
            .find(|name| hostname::matches(name, host, flags))
        {
            return Ok(Some(String::from_utf8_lossy(name).into_owned()));
        }
        let has_dns = !names.is_empty();
        if flags & 0x20 != 0 || (has_dns && flags & 0x01 == 0) {
            return Ok(None);
        }
        let subject = unsafe { ffi::X509_get_subject_name(self.p()) };
        for (name, value) in name_pairs(subject)? {
            if name == "CN" && hostname::matches(value.as_bytes(), host, flags) {
                return Ok(Some(value));
            }
        }
        Ok(None)
    }

    fn check_name(&self, kind: &str, value: &str, flags: u32) -> NativeResult {
        if value.contains('\0') {
            return Err(NativeError::type_error("Invalid certificate name")
                .prop("code", "ERR_INVALID_ARG_VALUE"));
        }
        if kind == "checkHost" {
            return Ok(self.check_host(value.as_bytes(), flags)?.into());
        }
        if kind == "checkEmail" {
            let matched = unsafe {
                ffi::X509_check_email(self.p(), value.as_ptr().cast(), value.len(), flags)
            } == 1;
            return Ok(matched.then_some(value).into());
        }
        let ip: std::net::IpAddr = value.parse().map_err(|_| {
            NativeError::type_error("Invalid IP address").prop("code", "ERR_INVALID_ARG_VALUE")
        })?;
        let bytes = match ip {
            std::net::IpAddr::V4(ip) => ip.octets().to_vec(),
            std::net::IpAddr::V6(ip) => ip.octets().to_vec(),
        };
        let matched =
            unsafe { ffi::X509_check_ip(self.p(), bytes.as_ptr(), bytes.len(), flags) } == 1;
        Ok(matched.then_some(value).into())
    }
}

struct DecodedExtension {
    nid: i32,
    value: NonNull<c_void>,
}
impl Drop for DecodedExtension {
    fn drop(&mut self) {
        unsafe {
            ffi::X509V3_EXT_free(self.nid, self.value.as_ptr());
        }
    }
}

fn extension_entry(nid: i32, entry: *mut c_void) -> Result<String> {
    if nid == 85 {
        return general_name(entry.cast());
    }
    let access = entry.cast::<ffi::AccessDescription>();
    let method = signature_name(unsafe { (*access).method });
    let location = general_name(unsafe { (*access).location })?;
    Ok(format!("{method} - {location}"))
}

fn asn1_bytes(value: *const ffi::Asn1String) -> Vec<u8> {
    let len = unsafe { ffi::ASN1_STRING_length(value) };
    if len <= 0 {
        return Vec::new();
    }
    unsafe { std::slice::from_raw_parts(ffi::ASN1_STRING_get0_data(value), len as usize) }.to_vec()
}

fn general_name(name: *const ffi::GeneralName) -> Result<String> {
    let mut kind = -1;
    let value = unsafe { ffi::GENERAL_NAME_get0_value(name, &mut kind) };
    match kind {
        1 | 2 | 6 => {
            let prefix = match kind {
                1 => "email",
                2 => "DNS",
                _ => "URI",
            };
            Ok(format!(
                "{prefix}:{}",
                alternative_name(&asn1_bytes(value.cast()), false)
            ))
        }
        4 => {
            let flags = (1 << 16) | (1 << 20) | (1 << 24) | 0x311;
            let text =
                printed(|bio| unsafe { ffi::X509_NAME_print_ex(bio, value.cast(), 0, flags) })?;
            Ok(format!(
                "DirName:{}",
                alternative_name(text.as_bytes(), true)
            ))
        }
        7 => Ok(format!("IP Address:{}", ip_name(&asn1_bytes(value.cast())))),
        8 => Ok(format!("Registered ID:{}", oid_text(value.cast()))),
        0 => Ok("othername:<unsupported>".to_owned()),
        3 => Ok("X400Name:<unsupported>".to_owned()),
        5 => Ok("EdiPartyName:<unsupported>".to_owned()),
        _ => Err(invalid()),
    }
}

fn ip_name(bytes: &[u8]) -> String {
    if bytes.len() == 4 {
        return bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(".");
    }
    if bytes.len() == 16 {
        return bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| format!("{:X}", u16::from_be_bytes([pair[0], pair[1]])))
            .collect::<Vec<_>>()
            .join(":");
    }
    "<invalid>".to_owned()
}

// Bun src/jsc/bindings/ncrypto.cpp, IsSafeAltName and PrintAltName, cd95fa7a1.
fn alternative_name(bytes: &[u8], utf8: bool) -> String {
    let safe = bytes.iter().all(|byte| {
        !matches!(*byte, b'"' | b'\\' | b',' | b'\'')
            && *byte >= 32
            && *byte != 127
            && (utf8 || *byte <= 126)
    });
    if safe {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut output = vec![b'"'];
    for &byte in bytes {
        match byte {
            b'\\' => output.extend_from_slice(b"\\\\"),
            b'"' => output.extend_from_slice(b"\\\""),
            32..=43 | 45..=126 => output.push(byte),
            128..=255 if utf8 => output.push(byte),
            _ => output.extend_from_slice(format!("\\u00{byte:02x}").as_bytes()),
        }
    }
    output.push(b'"');
    String::from_utf8_lossy(&output).into_owned()
}

fn fingerprint(algorithm: &str, bytes: &[u8]) -> String {
    crate::encoding::digest(algorithm, bytes)
        .unwrap()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn encoded(write: impl Fn(*mut *mut u8) -> i32) -> Result<Vec<u8>> {
    let length = write(ptr::null_mut());
    if length <= 0 {
        return Err(invalid());
    }
    let mut output = vec![0; length as usize];
    let mut cursor = output.as_mut_ptr();
    if write(&mut cursor) != length {
        return Err(invalid());
    }
    Ok(output)
}

fn printed(write: impl FnOnce(*mut ffi::Bio) -> i32) -> Result<String> {
    let bio = Bio(NonNull::new(unsafe { ffi::BIO_new(ffi::BIO_s_mem()) }).ok_or_else(invalid)?);
    write(bio.0.as_ptr());
    let mut contents = ptr::null();
    let mut len = 0;
    if unsafe { ffi::BIO_mem_contents(bio.0.as_ptr(), &mut contents, &mut len) } != 1 {
        return Err(invalid());
    }
    if len == 0 {
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(contents, len) }).into_owned())
}

fn name(name: *const ffi::Name) -> Result<Option<String>> {
    if unsafe { ffi::X509_NAME_entry_count(name) } == 0 {
        return Ok(None);
    }
    printed(|bio| unsafe { ffi::X509_NAME_print_ex(bio, name, 0, (4 << 16) | 0x10 | 2) }).map(Some)
}

fn signature_name(object: *const ffi::Asn1Object) -> String {
    let nid = unsafe { ffi::OBJ_obj2nid(object) };
    if nid == 0 {
        return oid_text(object);
    }
    let name = unsafe { ffi::OBJ_nid2ln(nid) };
    if name.is_null() {
        return oid_text(object);
    }
    unsafe { CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned()
}

fn object_name(object: *const ffi::Asn1Object) -> String {
    let nid = unsafe { ffi::OBJ_obj2nid(object) };
    if nid == 0 {
        return oid_text(object);
    }
    let name = unsafe { ffi::OBJ_nid2sn(nid) };
    if name.is_null() {
        return oid_text(object);
    }
    unsafe { CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned()
}

fn oid_text(object: *const ffi::Asn1Object) -> String {
    let len = unsafe { ffi::OBJ_obj2txt(ptr::null_mut(), 0, object, 1) };
    if len <= 0 {
        return String::new();
    }
    let mut bytes = vec![0; len as usize + 1];
    unsafe {
        ffi::OBJ_obj2txt(bytes.as_mut_ptr().cast(), bytes.len() as i32, object, 1);
    }
    bytes.pop();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn name_entries(name: *const ffi::Name) -> Result<Val> {
    Ok(name_pairs(name)?
        .into_iter()
        .map(|(name, value)| Val::Array(vec![name.into(), value.into()]))
        .collect::<Vec<_>>()
        .into())
}

fn name_pairs(name: *const ffi::Name) -> Result<Vec<(String, String)>> {
    let mut entries = Vec::new();
    for index in 0..unsafe { ffi::X509_NAME_entry_count(name) } {
        let entry = unsafe { ffi::X509_NAME_get_entry(name, index) };
        let object = unsafe { ffi::X509_NAME_ENTRY_get_object(entry) };
        let mut utf8 = ptr::null_mut();
        let len =
            unsafe { ffi::ASN1_STRING_to_UTF8(&mut utf8, ffi::X509_NAME_ENTRY_get_data(entry)) };
        if len < 0 {
            return Err(invalid());
        }
        let value = if len == 0 {
            String::new()
        } else {
            String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(utf8, len as usize) })
                .into_owned()
        };
        unsafe {
            ffi::OPENSSL_free(utf8.cast());
        }
        entries.push((object_name(object), value));
    }
    Ok(entries)
}

fn verify(cert: &Certificate, bytes: &[u8]) -> NativeResult {
    let mut cursor = bytes.as_ptr();
    let length = bytes.len().try_into().map_err(|_| invalid())?;
    let key = unsafe { ffi::d2i_PUBKEY(ptr::null_mut(), &mut cursor, length) };
    if key.is_null() {
        return Err(invalid());
    }
    let valid = cursor == bytes.as_ptr().wrapping_add(bytes.len())
        && unsafe { ffi::X509_verify(cert.p(), key) } == 1;
    unsafe {
        ffi::EVP_PKEY_free(key);
    }
    Ok(valid.into())
}

fn operation(a: Args<'_>) -> NativeResult {
    let _errors = ErrorQueue;
    let cert = Certificate::parse(a.bytes(1)?)?;
    match a.str(0)? {
        "parse" => cert.metadata(),
        "publicKey" => cert.public_key().map(Val::Bytes),
        "checkIssued" => {
            let issuer = Certificate::parse(a.bytes(2)?)?;
            Ok((unsafe { ffi::X509_check_issued(issuer.p(), cert.p()) } == 0).into())
        }
        "verify" => verify(&cert, a.bytes(2)?),
        "checkHost" | "checkEmail" | "checkIP" => cert.check_name(a.str(0)?, a.str(2)?, a.u32(3)?),
        _ => Err(invalid()),
    }
}

pub(crate) fn install(t: &mut Table) {
    t.add("x509", operation);
}
