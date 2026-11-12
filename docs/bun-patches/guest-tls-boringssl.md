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
owns the network BIO. TLS reuses X.509's opaque `Bio` type and single
`BIO_free` declaration, so Rust checks one C signature rather than two
incompatible opaque pointer declarations.

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

The lightweight CMake owner runs only source utility assertions. The separate
`native-probe` owner requires a trusted producer-job digest before any live TLS.
Its native-quality prerequisite records package and exact output-directory
events from the existing host Cargo test and final WASI Clippy invocation.
It validates every archive object's ABI, compiler metadata, CMake cache, source,
SDK, sysroot and split stamp. It never selects a first cache glob or runs another
crypto build. Native and WASI archives remain distinct.

The producer links the client and matched baseline once from those archives.
It saves each successful link hash before inspecting size, and retains the full
map, symbols and exact commands. The existing native checkpoint carries those
files. Intake recomputes current inputs and verifies the TLS digest from the
producing job output, never from a self-asserted report directory. Only then does
the live owner execute. Missing or changed evidence fails the blocking gate.
Every fixture owns its processes and private keys; the job owns build cleanup.
The old standalone crypto-builder CLI is removed.

The matched size baseline compiles the same test source and archives with
only the crypto entropy call retained. Stripped, gzip, and Brotli increments
include newly reachable verifier and TLS code. These are probe measurements,
not the size, startup, or heap increment of an application guest.

This preparation does not qualify shared-group globals, concurrent execution,
process teardown, browser behavior, PostgreSQL, or a release. The source manifest now inventories `ssl/` for guest and common-core inputs,
without changing separate engine inputs. Roots are not added until consumed.
CI input integration remains a separate gate. No application guest is built.
