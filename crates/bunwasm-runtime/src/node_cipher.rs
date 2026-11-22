//! node:crypto's Cipheriv and Decipheriv contexts on BoringSSL's EVP ciphers, as in Bun's
//! JSCipher (src/jsc/bindings/node/crypto/JSCipher*.cpp). `node_cipher.ts` validates the
//! JavaScript arguments; these natives own the checks that need the cipher itself.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::ptr;
use std::rc::Rc;

use bunwasm_crypto_sys::node::*;

use crate::data::{Args, NativeError, NativeResult, Record, Val};
use crate::natives::Table;

/// BoringSSL's error library numbers that Bun names in `ERR_OSSL_<LIB>_<REASON>` codes
/// (CryptoUtil.cpp createCryptoError); other libraries get `ERR_OSSL_<REASON>`.
const LIBRARIES: [(u32, &str); 28] = [
    (2, "SYS"),
    (3, "BN"),
    (4, "RSA"),
    (5, "DH"),
    (6, "EVP"),
    (7, "BUF"),
    (8, "OBJ"),
    (9, "PEM"),
    (10, "DSA"),
    (11, "X509"),
    (12, "ASN1"),
    (13, "CONF"),
    (14, "CRYPTO"),
    (15, "EC"),
    (16, "SSL"),
    (17, "BIO"),
    (18, "PKCS7"),
    (20, "X509V3"),
    (21, "RAND"),
    (22, "ENGINE"),
    (23, "OCSP"),
    (24, "UI"),
    (25, "COMP"),
    (26, "ECDSA"),
    (27, "ECDH"),
    (28, "HMAC"),
    (33, "CMS"),
    (34, "USER"),
];
const LIB_SSL: u32 = 16;

fn c_text(text: *const c_char) -> Option<String> {
    if text.is_null() {
        return None;
    }
    // SAFETY: BoringSSL returns static NUL-terminated strings.
    Some(
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned(),
    )
}

/// Bun's createCryptoError: the packed OpenSSL error's text and its library, function,
/// reason and code, or `fallback` with no code when nothing is queued.
fn crypto_error(packed: u32, fallback: &str) -> NativeError {
    if packed == 0 {
        return NativeError::error(fallback);
    }
    let mut buffer = [0 as c_char; 128];
    // SAFETY: the buffer is writable for its whole length; the strings are static.
    let (message, library, function, reason) = unsafe {
        ERR_error_string_n(packed, buffer.as_mut_ptr(), buffer.len());
        (
            c_text(buffer.as_ptr()).unwrap_or_default(),
            c_text(ERR_lib_error_string(packed)),
            c_text(ERR_func_error_string(packed)),
            c_text(ERR_reason_error_string(packed)),
        )
    };
    let mut error = NativeError::error(message);
    if let Some(library) = library {
        error = error.prop("library", library);
    }
    if let Some(function) = function {
        error = error.prop("function", function);
    }
    let Some(reason) = reason else { return error };
    let lib = packed >> 24 & 0xff;
    let name = LIBRARIES
        .iter()
        .find(|(id, _)| *id == lib)
        .map_or(String::new(), |(_, name)| format!("{name}_"));
    let prefix = if lib == LIB_SSL { "" } else { "OSSL_" };
    let code = format!(
        "ERR_{prefix}{name}{}",
        reason.to_ascii_uppercase().replace(' ', "_")
    );
    error.prop("reason", reason).prop("code", code)
}

/// The oldest queued OpenSSL error as Bun reports it, then an empty queue.
pub(crate) fn queued_error(fallback: &str) -> NativeError {
    // SAFETY: plain reads and a reset of this thread's error queue.
    let error = crypto_error(unsafe { ERR_peek_error() }, fallback);
    unsafe { ERR_clear_error() };
    error
}

/// Starts a native operation with no errors left over from an earlier one.
pub(crate) fn clear_errors() {
    // SAFETY: resets this thread's error queue.
    unsafe { ERR_clear_error() };
}

pub(crate) fn coded(error: NativeError, code: &str) -> NativeError {
    error.prop("code", code)
}

fn invalid_state(operation: &str) -> NativeError {
    let message = if operation.is_empty() {
        "Invalid state".to_owned()
    } else {
        format!("Invalid state for operation {operation}")
    };
    coded(NativeError::error(message), "ERR_CRYPTO_INVALID_STATE")
}

fn invalid_iv() -> NativeError {
    coded(
        NativeError::type_error("Invalid initialization vector"),
        "ERR_CRYPTO_INVALID_IV",
    )
}

fn invalid_tag(length: impl std::fmt::Display) -> NativeError {
    coded(
        NativeError::type_error(format!("Invalid authentication tag length: {length}")),
        "ERR_CRYPTO_INVALID_AUTH_TAG",
    )
}

/// ncrypto's Cipher::FromName: "aes128", "aes192" and "aes256" name the CBC ciphers.
fn cipher_by_name(name: &str) -> *const Cipher {
    let alias = name
        .get(..3)
        .filter(|prefix| prefix.eq_ignore_ascii_case("aes"))
        .map(|_| &name[3..]);
    let nid = match alias {
        Some("128") => 419,
        Some("192") => 423,
        Some("256") => 427,
        _ => 0,
    };
    if nid != 0 {
        // SAFETY: a lookup in BoringSSL's static table.
        return unsafe { EVP_get_cipherbynid(nid) };
    }
    let Ok(name) = CString::new(name) else {
        return ptr::null();
    };
    // SAFETY: a NUL-terminated name; BoringSSL returns a static cipher or null.
    unsafe { EVP_get_cipherbyname(name.as_ptr()) }
}

fn mode_label(mode: u32) -> Option<&'static str> {
    Some(match mode {
        EVP_CIPH_CCM_MODE => "ccm",
        EVP_CIPH_CFB_MODE => "cfb",
        EVP_CIPH_CBC_MODE => "cbc",
        EVP_CIPH_CTR_MODE => "ctr",
        EVP_CIPH_ECB_MODE => "ecb",
        EVP_CIPH_GCM_MODE => "gcm",
        EVP_CIPH_OCB_MODE => "ocb",
        EVP_CIPH_OFB_MODE => "ofb",
        EVP_CIPH_WRAP_MODE => "wrap",
        EVP_CIPH_XTS_MODE => "xts",
        EVP_CIPH_STREAM_CIPHER => "stream",
        _ => return None,
    })
}

/// A cipher context that frees itself.
struct Context(*mut CipherCtx);

impl Drop for Context {
    fn drop(&mut self) {
        // SAFETY: the context came from EVP_CIPHER_CTX_new and is freed once.
        unsafe { EVP_CIPHER_CTX_free(self.0) }
    }
}

impl Context {
    fn new() -> Result<Context, NativeError> {
        // SAFETY: allocates a zeroed context.
        let ctx = unsafe { EVP_CIPHER_CTX_new() };
        if ctx.is_null() {
            return Err(NativeError::range_error("Out of memory"));
        }
        Ok(Context(ctx))
    }

    fn ctrl(&self, command: c_int, arg: usize, data: *mut c_void) -> bool {
        // SAFETY: `data` is null or points at `arg` bytes, as the command requires.
        unsafe { EVP_CIPHER_CTX_ctrl(self.0, command, arg as c_int, data) > 0 }
    }

    fn init(&self, cipher: *const Cipher, encrypt: bool, key: *const u8, iv: *const u8) -> bool {
        // SAFETY: key and iv are null or hold the lengths the context was configured for.
        unsafe {
            EVP_CipherInit_ex(
                self.0,
                cipher,
                ptr::null_mut(),
                key,
                iv,
                c_int::from(encrypt),
            ) == 1
        }
    }
}

/// Bun's getCipherInfo: (name or nid, keyLength, ivLength).
fn cipher_info(a: &Args<'_>) -> NativeResult {
    let cipher = match a.get(0) {
        // SAFETY: a lookup in BoringSSL's static table.
        Val::Num(nid) => unsafe { EVP_get_cipherbynid(*nid as c_int) },
        _ => cipher_by_name(a.str(0)?),
    };
    if cipher.is_null() {
        return Ok(Val::Undefined);
    }
    // SAFETY: `cipher` is a static BoringSSL cipher.
    let (nid, mode, mut key_length, mut iv_length, block_size) = unsafe {
        (
            EVP_CIPHER_nid(cipher),
            EVP_CIPHER_mode(cipher),
            EVP_CIPHER_key_length(cipher),
            EVP_CIPHER_iv_length(cipher),
            EVP_CIPHER_block_size(cipher),
        )
    };
    let wanted_key = a.opt_num(1).map(|n| n as i32);
    let wanted_iv = a.opt_num(2).map(|n| n as i32);
    if wanted_key.is_some() || wanted_iv.is_some() {
        let ctx = Context::new()?;
        if !ctx.init(cipher, true, ptr::null(), ptr::null()) {
            clear_errors();
            return Ok(Val::Undefined);
        }
        if let Some(length) = wanted_key {
            // SAFETY: an initialized context.
            if unsafe { EVP_CIPHER_CTX_set_key_length(ctx.0, length as u32) } == 0 {
                clear_errors();
                return Ok(Val::Undefined);
            }
            key_length = length as u32;
        }
        if let Some(length) = wanted_iv {
            let fits = match mode {
                EVP_CIPH_CCM_MODE => (7..=13).contains(&length),
                EVP_CIPH_GCM_MODE => true,
                EVP_CIPH_OCB_MODE => {
                    ctx.ctrl(EVP_CTRL_AEAD_SET_IVLEN, length as usize, ptr::null_mut())
                }
                _ => length as u32 == iv_length,
            };
            clear_errors();
            if !fits {
                return Ok(Val::Undefined);
            }
            iv_length = length as u32;
        }
    }
    // SAFETY: BoringSSL's static object table.
    let name = c_text(unsafe { OBJ_nid2sn(nid) })
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut record = Record::new();
    if let Some(label) = mode_label(mode) {
        record = record.set("mode", label);
    }
    record = record.set("name", name).set("nid", nid as f64);
    if mode != EVP_CIPH_STREAM_CIPHER {
        record = record.set("blockSize", f64::from(block_size));
    }
    if iv_length != 0 {
        record = record.set("ivLength", f64::from(iv_length));
    }
    Ok(record.set("keyLength", f64::from(key_length)).into())
}

#[derive(PartialEq)]
enum TagState {
    Unknown,
    Known,
    Passed,
}

struct CipherState {
    ctx: Context,
    encrypt: bool,
    /// The tag length of an authenticated (GCM) cipher.
    tag_length: Option<usize>,
    tag: [u8; 16],
    tag_state: TagState,
    block_size: usize,
}

impl CipherState {
    /// JSCipher::maybePassAuthTagToOpenSSL.
    fn pass_tag(&mut self) -> bool {
        if self.tag_state != TagState::Known {
            return true;
        }
        let length = self.tag_length.unwrap_or(16);
        if !self
            .ctx
            .ctrl(EVP_CTRL_AEAD_SET_TAG, length, self.tag.as_mut_ptr().cast())
        {
            return false;
        }
        self.tag_state = TagState::Passed;
        true
    }

    fn update(&mut self, input: &[u8]) -> NativeResult {
        let mut output = vec![0u8; input.len() + self.block_size];
        let mut written: c_int = 0;
        // SAFETY: the output has room for the input plus one block, as EVP requires.
        let ok = unsafe {
            EVP_CipherUpdate(
                self.ctx.0,
                output.as_mut_ptr(),
                &mut written,
                input.as_ptr(),
                input.len() as c_int,
            )
        };
        if ok != 1 {
            return Err(queued_error("Trying to add data in unsupported state"));
        }
        output.truncate(written as usize);
        Ok(Val::Bytes(output))
    }

    /// Bun's final(): the last output, and for an encrypting AEAD cipher its tag.
    fn finish(mut self) -> NativeResult {
        let authenticated = self.tag_length.is_some();
        if !self.encrypt && authenticated {
            self.pass_tag();
        }
        let mut output = vec![0u8; self.block_size.max(1)];
        let mut written: c_int = 0;
        // SAFETY: the output holds one block, the most EVP_CipherFinal_ex writes.
        let mut ok =
            unsafe { EVP_CipherFinal_ex(self.ctx.0, output.as_mut_ptr(), &mut written) } == 1;
        let mut tag = Vec::new();
        if let Some(length) = self.tag_length.filter(|_| ok && self.encrypt) {
            tag = vec![0u8; length];
            ok = self
                .ctx
                .ctrl(EVP_CTRL_AEAD_GET_TAG, length, tag.as_mut_ptr().cast());
        }
        if !ok {
            let fallback = if authenticated {
                "Unsupported state or unable to authenticate data"
            } else {
                "Unsupported state"
            };
            return Err(queued_error(fallback));
        }
        output.truncate(written as usize);
        Ok(Record::new()
            .set("output", Val::Bytes(output))
            .set("tag", Val::Bytes(tag))
            .into())
    }
}

#[derive(Default)]
struct Ciphers {
    next: u32,
    live: HashMap<u32, CipherState>,
}

type Shared = Rc<RefCell<Ciphers>>;

/// Bun's constructCipher after its JavaScript argument checks:
/// (name, decrypt, key, iv or null, authTagLength or undefined).
fn create(a: &Args<'_>) -> Result<(CipherState, bool), NativeError> {
    let decrypt = a.bool(1);
    let key = a.bytes(2)?;
    let iv = a.opt_bytes(3);
    let mut tag_length = a.opt_num(4).map(|n| n as usize);
    let cipher = cipher_by_name(a.str(0)?);
    if cipher.is_null() {
        return Err(coded(
            NativeError::error("Unknown cipher"),
            "ERR_CRYPTO_UNKNOWN_CIPHER",
        ));
    }
    // SAFETY: `cipher` is a static BoringSSL cipher.
    let (expected_iv, mode, block_size) = unsafe {
        (
            EVP_CIPHER_iv_length(cipher) as usize,
            EVP_CIPHER_mode(cipher),
            EVP_CIPHER_block_size(cipher) as usize,
        )
    };
    // BoringSSL's EVP ciphers have no CCM, OCB or ChaCha20-Poly1305: GCM is the only AEAD.
    let gcm = mode == EVP_CIPH_GCM_MODE;
    match iv {
        None if expected_iv != 0 => return Err(invalid_iv()),
        Some(iv) if !gcm && iv.len() != expected_iv => return Err(invalid_iv()),
        // OpenSSL 3 caps GCM IVs at 1024 bits; Bun enforces the same limit.
        Some(iv) if gcm && iv.len() > 128 => return Err(invalid_iv()),
        _ => {}
    }
    let ctx = Context::new()?;
    if !ctx.init(cipher, !decrypt, ptr::null(), ptr::null()) {
        return Err(queued_error("Failed to initialize cipher"));
    }
    if gcm {
        if !ctx.ctrl(
            EVP_CTRL_AEAD_SET_IVLEN,
            iv.map_or(0, <[u8]>::len),
            ptr::null_mut(),
        ) {
            clear_errors();
            return Err(invalid_iv());
        }
        let length = *tag_length.get_or_insert(16);
        // NIST SP 800-38D: 4, 8, or 12 to 16 bytes.
        if !matches!(length, 4 | 8 | 12..=16) {
            return Err(invalid_tag(length));
        }
    } else {
        tag_length = None;
    }
    // SAFETY: an initialized context.
    if unsafe { EVP_CIPHER_CTX_set_key_length(ctx.0, key.len() as u32) } == 0 {
        clear_errors();
        return Err(coded(
            NativeError::range_error("Invalid key length"),
            "ERR_CRYPTO_INVALID_KEYLEN",
        ));
    }
    if !ctx.init(
        ptr::null(),
        !decrypt,
        key.as_ptr(),
        iv.map_or(ptr::null(), <[u8]>::as_ptr),
    ) {
        return Err(queued_error("Failed to initialize cipher"));
    }
    let state = CipherState {
        ctx,
        encrypt: !decrypt,
        tag_length,
        tag: [0; 16],
        tag_state: TagState::Unknown,
        block_size,
    };
    Ok((state, gcm))
}

fn with_cipher<T>(
    ciphers: &Shared,
    a: &Args<'_>,
    f: impl FnOnce(&mut CipherState) -> Result<T, NativeError>,
) -> Result<T, NativeError> {
    let mut ciphers = ciphers.borrow_mut();
    let state = ciphers
        .live
        .get_mut(&a.u32(0)?)
        .ok_or_else(|| invalid_state(""))?;
    clear_errors();
    f(state)
}

fn install_cipher_state(t: &mut Table, ciphers: &Shared) {
    let c = ciphers.clone();
    t.add("nodeCrypto.cipher", move |a| {
        clear_errors();
        let (state, gcm) = create(&a)?;
        let tag_length = state
            .tag_length
            .map_or(Val::Undefined, |n| Val::Num(n as f64));
        let mut ciphers = c.borrow_mut();
        ciphers.next += 1;
        let id = ciphers.next;
        ciphers.live.insert(id, state);
        Ok(Record::new()
            .set("id", id)
            .set("gcm", gcm)
            .set("tagLength", tag_length)
            .into())
    });
    let c = ciphers.clone();
    t.add("nodeCrypto.update", move |a| {
        with_cipher(&c, &a, |state| state.update(a.bytes(1)?))
    });
    let c = ciphers.clone();
    // Frees the context whether or not it succeeds, as Bun's final() resets it.
    t.add("nodeCrypto.final", move |a| {
        let state = c
            .borrow_mut()
            .live
            .remove(&a.u32(0)?)
            .ok_or_else(|| invalid_state(""))?;
        clear_errors();
        state.finish()
    });
    let c = ciphers.clone();
    t.add("nodeCrypto.setAAD", move |a| {
        with_cipher(&c, &a, |state| {
            let aad = a.bytes(1)?;
            let mut written: c_int = 0;
            // SAFETY: an AEAD context takes AAD with a null output.
            let ok = state.tag_length.is_some()
                && unsafe {
                    EVP_CipherUpdate(
                        state.ctx.0,
                        ptr::null_mut(),
                        &mut written,
                        aad.as_ptr(),
                        aad.len() as c_int,
                    )
                } == 1;
            clear_errors();
            if ok {
                Ok(Val::Undefined)
            } else {
                Err(invalid_state("setAAD"))
            }
        })
    });
    let c = ciphers.clone();
    t.add("nodeCrypto.setAuthTag", move |a| {
        with_cipher(&c, &a, |state| {
            let tag = a.bytes(1)?;
            let Some(length) = state
                .tag_length
                .filter(|_| !state.encrypt && state.tag_state == TagState::Unknown)
            else {
                return Err(invalid_state("setAuthTag"));
            };
            if tag.len() != length {
                return Err(invalid_tag(tag.len()));
            }
            state.tag = [0; 16];
            state.tag[..length].copy_from_slice(tag);
            state.tag_state = TagState::Known;
            Ok(Val::Undefined)
        })
    });
    let c = ciphers.clone();
    t.add("nodeCrypto.setAutoPadding", move |a| {
        with_cipher(&c, &a, |state| {
            // SAFETY: a live context.
            unsafe { EVP_CIPHER_CTX_set_padding(state.ctx.0, c_int::from(a.bool(1))) };
            Ok(Val::Undefined)
        })
    });
    let c = ciphers.clone();
    t.add("nodeCrypto.release", move |a| {
        c.borrow_mut().live.remove(&a.u32(0)?);
        Ok(Val::Undefined)
    });
    // bun:internal-for-testing's liveCipherCount: contexts not yet finished or collected.
    let c = ciphers.clone();
    t.add("nodeCrypto.liveCiphers", move |_| {
        Ok(Val::Num(c.borrow().live.len() as f64))
    });
}

/// `native.nodeCrypto.*` for ciphers; `node_dh.rs` adds Diffie-Hellman, ECDH and primes.
pub fn install(t: &mut Table) {
    t.add("nodeCrypto.cipherInfo", |a| cipher_info(&a));
    install_cipher_state(t, &Shared::default());
    crate::node_dh::install(t);
    crate::node_rsa::install(t);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn field<'a>(value: &'a Val, name: &str) -> &'a Val {
        let Val::Object(fields) = value else {
            panic!("not an object: {value:?}")
        };
        &fields.iter().find(|(key, _)| key == name).unwrap().1
    }

    fn cipher(
        name: &str,
        decrypt: bool,
        key: &[u8],
        iv: Option<&[u8]>,
        tag: Option<f64>,
    ) -> Result<CipherState, NativeError> {
        let iv = iv.map_or(Val::Null, |iv| Val::Bytes(iv.to_vec()));
        let tag = tag.map_or(Val::Undefined, Val::Num);
        create(&Args(&[
            name.into(),
            Val::Bool(decrypt),
            Val::Bytes(key.to_vec()),
            iv,
            tag,
        ]))
        .map(|(state, _)| state)
    }

    fn code(error: &NativeError) -> Option<&Val> {
        error
            .props
            .iter()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value)
    }

    #[test]
    fn cipher_info_matches_bun() {
        let info = cipher_info(&Args(&["aes-256-gcm".into()])).unwrap();
        assert_eq!(field(&info, "name"), &Val::from("id-aes256-gcm"));
        assert_eq!(field(&info, "ivLength"), &Val::Num(12.0));
        let aliased = cipher_info(&Args(&["AES128".into()])).unwrap();
        assert_eq!(field(&aliased, "name"), &Val::from("aes-128-cbc"));
        assert_eq!(
            cipher_info(&Args(&["aes-128-cbc".into(), Val::Num(12.0)])).unwrap(),
            Val::Undefined
        );
        assert_eq!(
            cipher_info(&Args(&["nope".into()])).unwrap(),
            Val::Undefined
        );
    }

    // NIST SP 800-38A F.2.1 and the GCM specification's test case 2.
    #[test]
    fn vectors_round_trip() {
        let key = hex("2b7e151628aed2a6abf7158809cf4f3c");
        let iv = hex("000102030405060708090a0b0c0d0e0f");
        let mut cbc = cipher("aes-128-cbc", false, &key, Some(&iv), None).unwrap();
        // SAFETY: a live context.
        unsafe { EVP_CIPHER_CTX_set_padding(cbc.ctx.0, 0) };
        let Val::Bytes(out) = cbc
            .update(&hex("6bc1bee22e409f96e93d7e117393172a"))
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(out, hex("7649abac8119b246cee98e9b12e9197d"));
        let gcm = cipher("aes-128-gcm", false, &[0; 16], Some(&[0; 12]), None).unwrap();
        let mut gcm_state = gcm;
        let Val::Bytes(out) = gcm_state.update(&[0; 16]).unwrap() else {
            panic!()
        };
        assert_eq!(out, hex("0388dace60b6a392f328c2b971b2fe78"));
        let done = gcm_state.finish().unwrap();
        assert_eq!(
            field(&done, "tag"),
            &Val::Bytes(hex("ab6e47d42cec13bdf53a67b21257bddf"))
        );
    }

    #[test]
    fn errors_carry_bun_codes() {
        let unknown = cipher("aes-128-nope", false, &[0; 16], None, None)
            .err()
            .unwrap();
        assert_eq!(
            code(&unknown),
            Some(&Val::from("ERR_CRYPTO_UNKNOWN_CIPHER"))
        );
        let keylen = cipher("aes-128-cbc", false, &[0; 15], Some(&[0; 16]), None)
            .err()
            .unwrap();
        assert_eq!(code(&keylen), Some(&Val::from("ERR_CRYPTO_INVALID_KEYLEN")));
        let tag = cipher("aes-128-gcm", false, &[0; 16], Some(&[0; 12]), Some(3.0))
            .err()
            .unwrap();
        assert_eq!(tag.message, "Invalid authentication tag length: 3");
        let iv = cipher("aes-128-gcm", false, &[0; 16], Some(&[0; 129]), None)
            .err()
            .unwrap();
        assert_eq!(code(&iv), Some(&Val::from("ERR_CRYPTO_INVALID_IV")));
        let mut decipher = cipher("aes-128-cbc", true, &[1; 16], Some(&[0; 16]), None).unwrap();
        decipher.update(&[0; 16]).unwrap();
        let failure = decipher.finish().err().unwrap();
        assert_eq!(code(&failure), Some(&Val::from("ERR_OSSL_BAD_DECRYPT")));
        assert!(
            failure
                .message
                .ends_with("Cipher functions:OPENSSL_internal:BAD_DECRYPT"),
            "{}",
            failure.message
        );
    }
}
