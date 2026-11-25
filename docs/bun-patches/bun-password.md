# Bun.password on Bun's argon2 and bcrypt

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/password.rs` `hash`, `verify`, `normalise_argon2_version`, `check_argon2_limits`, `verify_bcrypt_phc` | Adapted upstream implementation | Bun `src/runtime/crypto/pwhash.rs` and the `PasswordObject` hash/verify core of `src/runtime/crypto/PasswordObject.rs` at `29cd95a2f47461589f2ec47a978b4efccfcef9f4` |
| `crates/bunwasm-runtime/src/js/bun_password.ts` option parsing, defaults and error messages | Adapted upstream implementation | Bun `src/runtime/crypto/PasswordObject.rs` (`AlgorithmValue::from_js`, `js_password_object_*`) at the same revision |
| `rust-argon2` dependency | Upstream vendored crate, used unchanged | Bun `vendor/rust-argon2` at the same revision (`default-features = false`, so no thread pool) |
| `bcrypt = "=0.19.0"` dependency | Upstream crate choice | Bun's root `Cargo.toml` (`bcrypt = "0.19"`, locked at 0.19.0) |
| `natives.rs` `passwordHash`, `passwordVerify`, `password_error` | Original adapter | Error text and `PASSWORD_*` codes follow Bun's `password_error_instance` |

Bun has no BoringSSL password hashing, so it routes argon2 to its vendored pure-Rust `rust-argon2` and bcrypt to the `bcrypt` crate. bun-wasm does the same. The changes from upstream:

- `bun_core::strings` and `bun_base64` helpers become `str` methods and the `base64` crate (standard alphabet, no padding), with the same grammar.
- argon2 hashing always uses one lane (`p=1`), which is what `PasswordObject` passes.
- Bun hashes on its thread pool and settles a promise. The guest has one JavaScript thread, so `hash` and `verify` return a pending promise at once and compute on a later turn of the event loop through the real `setImmediate` queue, the way `crypto.pbkdf2` does; the hash itself still occupies that turn. Argument errors throw synchronously and hashing errors reject, as in Bun; `verify` with an empty password or hash returns an already-settled `false`, as Bun's `resolved_promise_value` does.
- rust-argon2 aborts when its memory allocation fails, and a guest has far less memory than a native process. Hashing and verification first reserve the Argon2 memory cost and report one the guest cannot allocate as `Password hashing failed: an Argon2 memory cost of N KiB is more memory than bun-wasm can allocate` (code `PASSWORD_OUT_OF_MEMORY`) instead of crashing. Native Bun would try it.
- Passwords longer than 72 bytes are prehashed with SHA-512 before bcrypt (the `sha2` crate here, Bun's `bun_sha_hmac` upstream), so bytes past 72 still count.

Defaults match Bun: argon2id with 64 MiB and 2 passes, bcrypt cost 10. Verification caps the costs a stored argon2 hash may ask for (memory 4 GiB, time 65536, parallelism 64), rejects any argon2 version other than 0x13, and reads bcrypt hashes in both `$2b$` and PHC `$bcrypt$` form.

`cargo test -p bunwasm-runtime password` covers round trips, the long-password prehash, wrong algorithms and hostile hashes. The `Bun.password` checks of `tests/fixtures/bun-probe-utils` compare the runtime with native Bun on every engine.
