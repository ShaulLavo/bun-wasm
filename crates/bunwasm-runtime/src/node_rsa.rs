//! node:crypto's publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt on
//! BoringSSL, as Bun's rsaFunction (src/jsc/bindings/node/crypto/JSCipher.cpp) runs them
//! through ncrypto's Cipher, and the PEM and PKCS#8 key encryption the Node key objects use.
//! `crypto_keys.ts` reads the options and the key first.

use std::ffi::CString;

use bunwasm_crypto_sys::{bunwasm_key_encoding, bunwasm_rsa_cipher};

use crate::data::{Args, NativeError, NativeResult, Val};
use crate::natives::Table;
use crate::node_cipher::{clear_errors, crypto_error, queued_error};

/// Arguments: operation (0 publicEncrypt, 1 privateDecrypt, 2 privateEncrypt,
/// 3 publicDecrypt), the key's JWK as JSON, the padding, the OAEP digest's BoringSSL name or
/// undefined, the OAEP label and the input.
fn rsa_cipher(a: &Args) -> NativeResult {
    let op = a.i32(0)?;
    if !(0..=3).contains(&op) {
        return Err(NativeError::type_error("Invalid RSA operation"));
    }
    let private = op == 1 || op == 2;
    let der = crate::crypto::rsa_pkcs1_der(a.str(1)?, private)
        .map_err(|_| NativeError::type_error("Invalid RSA key"))?;
    let padding = a.i32(2)?;
    let hash = a
        .opt_str(3)
        .map(CString::new)
        .transpose()
        .map_err(|_| NativeError::error("Invalid digest used"))?;
    let label = a.bytes(4)?;
    let input = a.bytes(5)?;
    // The PKCS#1 encoding is longer than the modulus, which bounds every result.
    let mut output = vec![0u8; der.len()];
    let mut length = output.len();
    clear_errors();
    // SAFETY: the adapter borrows each slice and the digest name for this call and writes at
    // most `length` bytes of `output`, then stores the written length.
    let ok = unsafe {
        bunwasm_rsa_cipher(
            op,
            der.as_ptr(),
            der.len(),
            padding,
            hash.as_ref().map_or(std::ptr::null(), |name| name.as_ptr()),
            label.as_ptr(),
            label.len(),
            input.as_ptr(),
            input.len(),
            output.as_mut_ptr(),
            &mut length,
        )
    };
    if ok != 1 || length > output.len() {
        return Err(queued_error("RSA operation failed"));
    }
    output.truncate(length);
    Ok(Val::Bytes(output))
}

/// Arguments: mode (0 PEM private key to PKCS#8, 1 DER PKCS#8 or encrypted PKCS#8 to
/// PKCS#8, 2 PEM PKCS#8, 3 DER PKCS#8, 4 PEM PKCS#1 and 5 PEM SEC1 encryption), the key,
/// the passphrase and the cipher name. A failure throws BoringSSL's oldest error, as Bun does.
fn key_encoding(a: &Args) -> NativeResult {
    let op = a.i32(0)?;
    if !(0..=5).contains(&op) {
        return Err(NativeError::type_error("Invalid key encoding"));
    }
    let input = a.bytes(1)?;
    let password = a.bytes(2)?;
    let cipher = CString::new(a.str(3)?).map_err(|_| NativeError::error("Invalid cipher"))?;
    let capacity = input
        .len()
        .checked_mul(2)
        .and_then(|n| n.checked_add(4096))
        .ok_or_else(|| NativeError::range_error("Key too large"))?;
    let mut out = vec![0; capacity];
    let mut error = 0u32;
    // SAFETY: the adapter borrows the inputs, copies the encoded key into `out` within its
    // capacity and stores its error code.
    let size = unsafe {
        bunwasm_key_encoding(
            op,
            input.as_ptr(),
            input.len(),
            password.as_ptr(),
            password.len(),
            cipher.as_ptr(),
            out.as_mut_ptr(),
            out.len(),
            &mut error,
        )
    };
    if size == 0 || size > out.len() {
        return Err(crypto_error(error, "Key encoding failed"));
    }
    out.truncate(size);
    Ok(Val::Bytes(out))
}

pub fn install(t: &mut Table) {
    t.add("nodeCrypto.rsaCipher", |a| rsa_cipher(&a));
    t.add("nodeCrypto.keyEncoding", |a| key_encoding(&a));
}
