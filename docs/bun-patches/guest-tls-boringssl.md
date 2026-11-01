# Guest TLS BoringSSL linkage

Classification: original adapter and test-only probe.

Upstream is `oven-sh/boringssl` commit
`41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f`. The declarations follow
`include/openssl/ssl.h`, `bio.h`, and `err.h`. No upstream source is copied or
patched. Bun remains pinned to `9510e74152073d850a18758ca41114d8f214ffa6`.

## Link the existing TLS library

`crates/bunwasm-crypto-sys/build.rs` builds `ssl` beside `crypto` and links
`ssl` first. The existing MinSizeRel, no-assembly, no-socket, thread-disabled
WASI flags, profile stamps, and static C++ runtime selection remain intact.
The WASI C++ flags also disable exceptions and RTTI. At this pin,
`CMakeLists.txt` applies `NO_CXX_RUNTIME_FLAGS` to `crypto`, but not `ssl`.
Without the explicit flags, `ssl/extensions.cc` requires exception symbols
that the selected no-exceptions C++ runtime does not supply.

The narrow Rust declarations expose library calls, not a registered runtime
TLS API. The verification callback has its actual C function-pointer type.
`ERR_get_error` returns the header's 32-bit unsigned value on native and WASI
builds. `SSL_set_bio` transfers the inside BIO to `SSL`; the caller separately
owns the network BIO.

## Run the standalone probe

The original C++ test client calls BoringSSL for the entire TLS protocol.
It uses a 16 KiB BIO pair and framed stdio instead of a socket BIO. The typed
host bridge feeds at most 1 KiB at a time. A separate native Node process uses
Node's TLS server, not the client implementation, as the peer.

The check executes TLS 1.2 and TLS 1.3, CA and hostname verification, ALPN,
application-byte exchange, and both close notifications. Unknown CA, expired
leaf, and hostname mismatch require their specific verifier error before any
application payload. A pinned native libssl client supplies an additional
linkage control. The same WASI binary runs with a failing `random_get` import;
missing tools, timeouts, or generic process failures are not entropy passes.

Use fresh task-owned paths and an external two-job, 4 GiB execution limit:

```sh
source env.sh
bun scripts/tls-probe.ts --source "$TLS_SOURCE" \
  --build "$TLS_BUILD" --output "$TLS_OUTPUT" --compile-only
BUNWASM_TLS_PROBE_OUTPUT="$TLS_OUTPUT" bun scripts/test-checks.ts cmake
```

The builder compares the complete input directory with a fresh archive of
the pinned upstream commit. `build.json` binds the probe bytes, native client,
source inputs, flags, profile, and sysroot metadata. The selected check rejects
missing or mismatched evidence and reruns the controls. It does not accept
booleans from a previous result file. Each run removes its generated fixture
keys and processes; the caller owns removal of its build and output directory.

The matched size baseline compiles the same test source and archives with
only the crypto entropy call retained. Stripped, gzip, and Brotli increments
include newly reachable verifier and TLS code. These are probe measurements,
not the size, startup, or heap increment of an application guest.

This preparation does not qualify shared-group globals, concurrent execution,
process teardown, browser behavior, PostgreSQL, or a release. Source-manifest
and CI input handoffs remain separately owned. No application guest is built.
