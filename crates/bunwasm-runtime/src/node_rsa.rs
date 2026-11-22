//! node:crypto's publicEncrypt, privateDecrypt, privateEncrypt and publicDecrypt on
//! BoringSSL, as Bun's rsaFunction (src/jsc/bindings/node/crypto/JSCipher.cpp) runs them
//! through ncrypto's Cipher. `crypto_keys.ts` reads the options and the key first.

use bunwasm_crypto_sys::bunwasm_rsa_cipher;

use crate::data::{Args, NativeError, NativeResult, Val};
use crate::natives::Table;
use crate::node_cipher::{clear_errors, queued_error};

/// Arguments: operation (0 publicEncrypt, 1 privateDecrypt, 2 privateEncrypt,
/// 3 publicDecrypt), the key's JWK as JSON, the padding, the OAEP digest name or
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
    let hash = match a.opt_str(3) {
        Some(name) => crate::crypto::rsa_digest(name)
            .ok_or_else(|| NativeError::error("Invalid digest used"))?,
        None => 0,
    };
    let label = a.bytes(4)?;
    let input = a.bytes(5)?;
    // The PKCS#1 encoding is longer than the modulus, which bounds every result.
    let mut output = vec![0u8; der.len()];
    let mut length = output.len();
    clear_errors();
    // SAFETY: the adapter borrows each slice for this call and writes at most `length`
    // bytes of `output`, then stores the written length.
    let ok = unsafe {
        bunwasm_rsa_cipher(
            op,
            der.as_ptr(),
            der.len(),
            padding,
            hash,
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

pub fn install(t: &mut Table) {
    t.add("nodeCrypto.rsaCipher", |a| rsa_cipher(&a));
}
