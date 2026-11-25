//! `Bun.password` hashing, adapted from Bun's `src/runtime/crypto/pwhash.rs` and the
//! `Password` core of `src/runtime/crypto/PasswordObject.rs`
//! (docs/bun-patches/bun-password.md). Like Bun, argon2 runs on the vendored pure-Rust
//! `rust-argon2` and bcrypt on the `bcrypt` crate; JavaScript argument handling lives in
//! `js/bun_password.ts`.

use sha2::{Digest, Sha512};

const ARGON2_SALT_LEN: usize = 32;
const ARGON2_HASH_LEN: u32 = 32;
const MAX_VERIFY_TIME_COST: u32 = 1 << 16;
const MAX_VERIFY_MEMORY_COST: u32 = 1 << 22;
const MAX_VERIFY_PARALLELISM: u32 = 64;
const BCRYPT_SALT_LEN: usize = 16;
const BCRYPT_DK_LEN: usize = 23;
const BCRYPT_MAX_PASSWORD: usize = 72;

/// Bun's error names, which `Bun.password` puts in its messages and `code`s.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Error {
    InvalidEncoding,
    WeakParameters,
    UnsupportedAlgorithm,
    Unexpected,
}

impl Error {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Error::InvalidEncoding => "InvalidEncoding",
            Error::WeakParameters => "WeakParameters",
            Error::UnsupportedAlgorithm => "UnsupportedAlgorithm",
            Error::Unexpected => "Unexpected",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Algorithm {
    Argon2d,
    Argon2i,
    Argon2id,
    Bcrypt,
}

impl Algorithm {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "argon2d" => Some(Self::Argon2d),
            "argon2i" => Some(Self::Argon2i),
            "argon2id" => Some(Self::Argon2id),
            "bcrypt" => Some(Self::Bcrypt),
            _ => None,
        }
    }

    /// The algorithm an encoded hash names (Bun's `Algorithm::get`).
    fn of_hash(encoded: &[u8]) -> Option<Self> {
        let rest = encoded.strip_prefix(b"$")?;
        if rest.starts_with(b"argon2d$") {
            return Some(Self::Argon2d);
        }
        if rest.starts_with(b"argon2i$") {
            return Some(Self::Argon2i);
        }
        if rest.starts_with(b"argon2id$") {
            return Some(Self::Argon2id);
        }
        if rest.starts_with(b"bcrypt") || rest.starts_with(b"2") {
            return Some(Self::Bcrypt);
        }
        None
    }

    fn variant(self) -> argon2::Variant {
        match self {
            Self::Argon2d => argon2::Variant::Argon2d,
            Self::Argon2i => argon2::Variant::Argon2i,
            Self::Argon2id | Self::Bcrypt => argon2::Variant::Argon2id,
        }
    }
}

/// `cost` is bcrypt's log2 rounds; argon2 uses `memory_cost` (KiB) and `time_cost`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Params {
    pub(crate) algorithm: Algorithm,
    pub(crate) cost: u32,
    pub(crate) memory_cost: u32,
    pub(crate) time_cost: u32,
}

/// bcrypt silently truncates passwords longer than 72 bytes, so Bun hashes those with
/// SHA-512 first and feeds the 64-byte digest to bcrypt.
fn bcrypt_input(password: &[u8]) -> std::borrow::Cow<'_, [u8]> {
    if password.len() <= BCRYPT_MAX_PASSWORD {
        return std::borrow::Cow::Borrowed(password);
    }
    std::borrow::Cow::Owned(Sha512::digest(password).to_vec())
}

pub(crate) fn hash(password: &[u8], params: Params) -> Result<String, Error> {
    if params.algorithm == Algorithm::Bcrypt {
        let parts =
            bcrypt::hash_with_result(bcrypt_input(password), params.cost).map_err(map_bcrypt)?;
        return Ok(parts.format_for_version(bcrypt::Version::TwoB));
    }
    let mut salt = [0u8; ARGON2_SALT_LEN];
    getrandom::fill(&mut salt).map_err(|_| Error::Unexpected)?;
    let config = argon2::Config {
        ad: &[],
        secret: &[],
        hash_length: ARGON2_HASH_LEN,
        lanes: 1,
        mem_cost: params.memory_cost,
        time_cost: params.time_cost,
        thread_mode: argon2::ThreadMode::Sequential,
        variant: params.algorithm.variant(),
        version: argon2::Version::Version13,
    };
    argon2::hash_encoded(password, &salt, &config).map_err(map_argon2)
}

/// `Ok(false)` for a wrong password or an empty hash; `Err` for a hash the chosen algorithm
/// cannot read. An explicit `algorithm` overrides the one the hash names, as in Bun.
pub(crate) fn verify(
    password: &[u8],
    encoded: &[u8],
    algorithm: Option<Algorithm>,
) -> Result<bool, Error> {
    if encoded.is_empty() {
        return Ok(false);
    }
    let algorithm = algorithm
        .or_else(|| Algorithm::of_hash(encoded))
        .ok_or(Error::UnsupportedAlgorithm)?;
    // PHC and modular-crypt strings are ASCII.
    let encoded = std::str::from_utf8(encoded)
        .ok()
        .filter(|text| text.is_ascii())
        .ok_or(Error::InvalidEncoding)?;
    if algorithm == Algorithm::Bcrypt {
        return verify_bcrypt(encoded, &bcrypt_input(password));
    }
    verify_argon2(encoded, password)
}

fn verify_argon2(encoded: &str, password: &[u8]) -> Result<bool, Error> {
    let normalised = normalise_argon2_version(encoded)?;
    check_argon2_limits(&normalised)?;
    argon2::verify_encoded(&normalised, password).map_err(map_argon2)
}

/// Bun accepts only version 0x13: an explicit `v=` other than 19 is an encoding error, and
/// a missing one means 19 (rust-argon2 would default to 0x10).
fn normalise_argon2_version(encoded: &str) -> Result<std::borrow::Cow<'_, str>, Error> {
    let Some(after) = encoded.strip_prefix('$') else {
        return Ok(encoded.into());
    };
    let Some(sep) = after.find('$') else {
        return Ok(encoded.into());
    };
    let alg_end = 1 + sep;
    let rest = &encoded[alg_end + 1..];
    if let Some(version) = rest.strip_prefix("v=") {
        let end = version.find('$').unwrap_or(version.len());
        if &version[..end] != "19" {
            return Err(Error::InvalidEncoding);
        }
        return Ok(encoded.into());
    }
    Ok(format!("{}v=19${rest}", &encoded[..=alg_end]).into())
}

/// Caps the cost a stored hash may demand, as Bun does, so a hostile hash cannot exhaust memory.
fn check_argon2_limits(encoded: &str) -> Result<(), Error> {
    let mut segments = encoded.split('$').skip(2);
    let mut params = segments.next().unwrap_or("");
    if params.starts_with("v=") {
        params = segments.next().unwrap_or("");
    }
    for pair in params.split(',') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let limit = match key {
            "m" => MAX_VERIFY_MEMORY_COST,
            "t" => MAX_VERIFY_TIME_COST,
            "p" => MAX_VERIFY_PARALLELISM,
            _ => continue,
        };
        let value: u32 = value.parse().map_err(|_| Error::InvalidEncoding)?;
        if value > limit {
            return Err(Error::WeakParameters);
        }
    }
    Ok(())
}

fn verify_bcrypt(encoded: &str, password: &[u8]) -> Result<bool, Error> {
    if encoded.starts_with("$2") {
        return bcrypt::verify(password, encoded).map_err(map_bcrypt);
    }
    verify_bcrypt_phc(encoded, password)
}

/// `$bcrypt$r=N$<salt>$<hash>` with unpadded standard base64; the `bcrypt` crate has no PHC codec.
fn verify_bcrypt_phc(encoded: &str, password: &[u8]) -> Result<bool, Error> {
    use base64::Engine as _;
    let rest = encoded.strip_prefix('$').ok_or(Error::InvalidEncoding)?;
    let (alg, rest) = rest.split_once('$').ok_or(Error::InvalidEncoding)?;
    if alg != "bcrypt" {
        return Ok(false);
    }
    let mut parts = rest.split('$');
    let (Some(rounds), Some(salt), Some(hash), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(Error::InvalidEncoding);
    };
    let rounds: u32 = rounds
        .strip_prefix("r=")
        .and_then(|r| r.parse().ok())
        .ok_or(Error::InvalidEncoding)?;
    let engine = base64::engine::general_purpose::STANDARD_NO_PAD;
    let salt: [u8; BCRYPT_SALT_LEN] = engine
        .decode(salt)
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or(Error::InvalidEncoding)?;
    let expected = engine.decode(hash).map_err(|_| Error::InvalidEncoding)?;
    if expected.len() != BCRYPT_DK_LEN {
        return Err(Error::InvalidEncoding);
    }
    if !(4..=31).contains(&rounds) {
        return Err(Error::WeakParameters);
    }
    // The crate's `_hash_password`: NUL-terminate, then clamp to 72 bytes.
    let mut buf = [0u8; BCRYPT_MAX_PASSWORD];
    let copy_len = password.len().min(BCRYPT_MAX_PASSWORD);
    buf[..copy_len].copy_from_slice(&password[..copy_len]);
    let used = (copy_len + 1).min(BCRYPT_MAX_PASSWORD);
    let computed = bcrypt::bcrypt(rounds, salt, &buf[..used]);
    Ok(subtle::ConstantTimeEq::ct_eq(&computed[..BCRYPT_DK_LEN], &expected[..]).into())
}

fn map_argon2(error: argon2::Error) -> Error {
    match error {
        argon2::Error::DecodingFail
        | argon2::Error::IncorrectType
        | argon2::Error::IncorrectVersion => Error::InvalidEncoding,
        _ => Error::WeakParameters,
    }
}

fn map_bcrypt(error: bcrypt::BcryptError) -> Error {
    match error {
        bcrypt::BcryptError::CostNotAllowed(_) => Error::WeakParameters,
        bcrypt::BcryptError::Rand(_) => Error::Unexpected,
        _ => Error::InvalidEncoding,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argon(algorithm: Algorithm) -> Params {
        Params {
            algorithm,
            cost: 0,
            memory_cost: 64,
            time_cost: 1,
        }
    }

    #[test]
    fn argon2_round_trip_and_mismatch() {
        let encoded = hash(b"hunter2", argon(Algorithm::Argon2id)).unwrap();
        assert!(encoded.starts_with("$argon2id$v=19$m=64,t=1,p=1$"));
        assert_eq!(verify(b"hunter2", encoded.as_bytes(), None), Ok(true));
        assert_eq!(verify(b"wrong", encoded.as_bytes(), None), Ok(false));
        assert_eq!(
            verify(b"hunter2", encoded.as_bytes(), Some(Algorithm::Bcrypt)),
            Ok(false)
        );
        assert_eq!(verify(b"hunter2", b"", None), Ok(false));
    }

    #[test]
    fn bcrypt_round_trip_and_long_password() {
        let params = Params {
            algorithm: Algorithm::Bcrypt,
            cost: 4,
            memory_cost: 0,
            time_cost: 0,
        };
        let long = [b'a'; 100];
        let encoded = hash(&long, params).unwrap();
        assert!(encoded.starts_with("$2b$04$"));
        assert_eq!(verify(&long, encoded.as_bytes(), None), Ok(true));
        // Prehashing keeps bytes past 72 significant.
        let mut other = long;
        other[99] = b'b';
        assert_eq!(verify(&other, encoded.as_bytes(), None), Ok(false));
    }

    #[test]
    fn verify_rejects_unknown_and_hostile_hashes() {
        assert_eq!(
            verify(b"x", b"plain", None),
            Err(Error::UnsupportedAlgorithm)
        );
        assert_eq!(
            verify(
                b"x",
                b"$argon2id$v=16$m=64,t=1,p=1$c2FsdHNhbHQ$aGFzaA",
                None
            ),
            Err(Error::InvalidEncoding)
        );
        assert_eq!(
            verify(
                b"x",
                b"$argon2id$v=19$m=99999999,t=1,p=1$c2FsdHNhbHQ$aGFzaA",
                None
            ),
            Err(Error::WeakParameters)
        );
    }
}
