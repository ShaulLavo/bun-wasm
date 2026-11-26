//! `Bun.CSRF` token generation and verification, ported from Bun's `src/csrf/lib.rs`
//! (docs/bun-patches/bun-csrf.md). Entropy, the clock and the signature comparison stay
//! native, so JavaScript code that replaces `crypto.getRandomValues` or `Date.now` cannot
//! steer them, as in Bun. `js/bun_csrf.ts` validates the options.

use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use subtle::ConstantTimeEq;

/// BoringSSL's `EVP_MAX_MD_SIZE` plus the 32-byte payload: the largest token Bun decodes.
const MAX_TOKEN_BYTES: usize = 64 + 32;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenFormat {
    Base64,
    Base64Url,
    Hex,
}

impl TokenFormat {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "base64" => Some(Self::Base64),
            "base64url" => Some(Self::Base64Url),
            "hex" => Some(Self::Hex),
            _ => None,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Bun's `RareData::default_csrf_secret`: 16 random bytes, made once per process. When the
/// entropy source fails nothing is cached and the caller fails, so no predictable secret is used.
fn default_secret() -> Option<&'static [u8]> {
    static SECRET: OnceLock<[u8; 16]> = OnceLock::new();
    if let Some(secret) = SECRET.get() {
        return Some(secret);
    }
    let mut secret = [0u8; 16];
    getrandom::fill(&mut secret).ok()?;
    Some(SECRET.get_or_init(|| secret))
}

fn sign(secret: &[u8], payload: &[u8], session_id: &[u8], algorithm: &str) -> Option<Vec<u8>> {
    let mut message = payload.to_vec();
    message.extend_from_slice(session_id);
    crate::node_digest::hmac(algorithm, secret, &message)
}

/// `secret` is `None` for Bun's per-process default. `algorithm` is a canonical
/// `node_digest` name the JavaScript side already allowed.
pub(crate) fn generate(
    secret: Option<&[u8]>,
    session_id: &[u8],
    expires_in_ms: u64,
    algorithm: &str,
    format: TokenFormat,
) -> Result<String, CsrfError> {
    let secret = secret_or_default(secret)?;
    let mut token = Vec::with_capacity(MAX_TOKEN_BYTES);
    token.extend_from_slice(&now_ms().to_be_bytes());
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| CsrfError::TokenCreationFailed)?;
    token.extend_from_slice(&nonce);
    token.extend_from_slice(&expires_in_ms.to_be_bytes());
    let signature =
        sign(secret, &token, session_id, algorithm).ok_or(CsrfError::TokenCreationFailed)?;
    token.extend_from_slice(&signature);
    Ok(encode(&token, format))
}

fn encode(bytes: &[u8], format: TokenFormat) -> String {
    match format {
        TokenFormat::Base64 => crate::encoding::base64_encode(bytes, false),
        TokenFormat::Base64Url => crate::encoding::base64_encode(bytes, true)
            .trim_end_matches('=')
            .to_owned(),
        TokenFormat::Hex => bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
    }
}

/// Bun's `bun_base64::decode_len`: the padded-decoder size, or `len / 4 * 3 + 2` when the
/// length is not a multiple of four.
fn base64_decoded_len(source: &[u8]) -> usize {
    if !source.len().is_multiple_of(4) {
        return source.len() / 4 * 3 + 2;
    }
    let pads = source
        .iter()
        .rev()
        .take(2)
        .take_while(|&&byte| byte == b'=')
        .count();
    source.len() / 4 * 3 - pads
}

fn decode(token: &[u8], format: TokenFormat) -> Option<Vec<u8>> {
    // Bun drops one trailing NUL, then bounds the decoded size before decoding.
    let token = token.strip_suffix(&[0]).unwrap_or(token);
    if format == TokenFormat::Hex {
        if !token.len().is_multiple_of(2) || token.len() / 2 > MAX_TOKEN_BYTES {
            return None;
        }
        // Hex digits only: `u8::from_str_radix` would also take a sign ("+0").
        return token
            .chunks(2)
            .map(|pair| Some(hex_digit(pair[0])? << 4 | hex_digit(pair[1])?))
            .collect();
    }
    let trimmed = trim(token);
    if trimmed.is_empty() || base64_decoded_len(trimmed) > MAX_TOKEN_BYTES {
        return None;
    }
    // Bun falls back to Node's forgiving decoder, which skips characters outside both alphabets.
    Some(crate::encoding::base64_decode(&String::from_utf8_lossy(
        trimmed,
    )))
}

fn hex_digit(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

/// `strings::trim(token, b"\r\n\t \x0b")` from Bun's verify.
fn trim(mut bytes: &[u8]) -> &[u8] {
    const SPACE: &[u8] = b"\r\n\t \x0b";
    while let [first, rest @ ..] = bytes {
        if !SPACE.contains(first) {
            break;
        }
        bytes = rest;
    }
    while let [rest @ .., last] = bytes {
        if !SPACE.contains(last) {
            break;
        }
        bytes = rest;
    }
    bytes
}

fn expired(timestamp: u64, lifetime: u64, now: u64) -> bool {
    lifetime > 0 && (u64::MAX - timestamp < lifetime || now > timestamp + lifetime)
}

/// Why a CSRF call failed instead of answering.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CsrfError {
    /// The entropy source failed while making the per-process default secret.
    NoSecret,
    TokenCreationFailed,
}

fn secret_or_default(secret: Option<&[u8]>) -> Result<&[u8], CsrfError> {
    match secret {
        Some(secret) => Ok(secret),
        None => default_secret().ok_or(CsrfError::NoSecret),
    }
}

pub(crate) fn verify(
    token: &[u8],
    secret: Option<&[u8]>,
    session_id: &[u8],
    max_age_ms: u64,
    algorithm: &str,
    format: TokenFormat,
) -> Result<bool, CsrfError> {
    // Bun reads the secret, making the default one if needed, before it looks at the token.
    let secret = secret_or_default(secret)?;
    Ok(verify_with(
        token, secret, session_id, max_age_ms, algorithm, format,
    ))
}

fn verify_with(
    token: &[u8],
    secret: &[u8],
    session_id: &[u8],
    max_age_ms: u64,
    algorithm: &str,
    format: TokenFormat,
) -> bool {
    let Some(decoded) = decode(token, format) else {
        return false;
    };
    if decoded.len() < 64 {
        return false;
    }
    let timestamp = u64::from_be_bytes(decoded[0..8].try_into().expect("8 bytes"));
    let expires_in = u64::from_be_bytes(decoded[24..32].try_into().expect("8 bytes"));
    let now = now_ms();
    if expired(timestamp, expires_in, now) || expired(timestamp, max_age_ms, now) {
        return false;
    }
    let Some(expected) = sign(secret, &decoded[..32], session_id, algorithm) else {
        return false;
    };
    let received = &decoded[32..];
    received.len() == expected.len() && bool::from(received.ct_eq(&expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verify_ok(
        token: &[u8],
        secret: Option<&[u8]>,
        session: &[u8],
        max_age: u64,
        algorithm: &str,
        format: TokenFormat,
    ) -> bool {
        verify(token, secret, session, max_age, algorithm, format).unwrap()
    }

    #[test]
    fn hex_tokens_reject_signs() {
        assert_eq!(decode(b"+0ab", TokenFormat::Hex), None);
        assert_eq!(decode(b"0aAB", TokenFormat::Hex), Some(vec![0x0a, 0xab]));
    }

    #[test]
    fn round_trips_in_every_format_and_rejects_tampering() {
        for format in [
            TokenFormat::Base64,
            TokenFormat::Base64Url,
            TokenFormat::Hex,
        ] {
            let token = generate(Some(b"s"), b"user", 60_000, "sha256", format).unwrap();
            assert!(verify_ok(
                token.as_bytes(),
                Some(b"s"),
                b"user",
                60_000,
                "sha256",
                format
            ));
            assert!(!verify_ok(
                token.as_bytes(),
                Some(b"t"),
                b"user",
                60_000,
                "sha256",
                format
            ));
            assert!(!verify_ok(
                token.as_bytes(),
                Some(b"s"),
                b"other",
                60_000,
                "sha256",
                format
            ));
        }
    }

    #[test]
    fn decodes_like_bun() {
        let hex = generate(Some(b"s"), b"", 0, "sha512", TokenFormat::Hex).unwrap();
        assert!(verify_ok(
            format!("{hex}\0").as_bytes(),
            Some(b"s"),
            b"",
            0,
            "sha512",
            TokenFormat::Hex
        ));
        assert!(!verify_ok(
            format!("{hex}\0\0").as_bytes(),
            Some(b"s"),
            b"",
            0,
            "sha512",
            TokenFormat::Hex
        ));
        assert!(verify_ok(
            hex.to_uppercase().as_bytes(),
            Some(b"s"),
            b"",
            0,
            "sha512",
            TokenFormat::Hex
        ));
        let url = generate(Some(b"s"), b"", 0, "sha256", TokenFormat::Base64Url).unwrap();
        assert!(verify_ok(
            format!(" !!{url}\n").as_bytes(),
            Some(b"s"),
            b"",
            0,
            "sha256",
            TokenFormat::Base64
        ));
        assert!(!verify_ok(
            format!("{url}AAAAAAAAAAAAAAAAAAAAAAAA").as_bytes(),
            Some(b"s"),
            b"",
            0,
            "sha256",
            TokenFormat::Base64Url
        ));
    }

    #[test]
    fn default_secret_is_stable_per_process() {
        let token = generate(None, b"", 0, "sha256", TokenFormat::Base64Url).unwrap();
        assert!(verify_ok(
            token.as_bytes(),
            None,
            b"",
            0,
            "sha256",
            TokenFormat::Base64Url
        ));
    }
}
