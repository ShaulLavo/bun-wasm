## CMake toolchain cache preflight

Class **Port**, implemented in the original build boundary. `scripts/check-cmake-cache.cmake` is a
read-only, fail-closed validator for existing Ninja CMake build directories. Before BoringSSL or
JavaScriptCore configure/build, it resolves the recorded C and C++ compiler paths, toolchain file,
CMake system and processor, compiler target flags in `rules.ninja`, and effective compile/link
sysroots, including `CMAKE_SYSROOT_COMPILE` and `CMAKE_SYSROOT_LINK` overrides. Native builds reject
an unexpected toolchain or sysroot; WASI builds require the requested paths to match and exist. A missing or malformed cache is rejected with a fresh-directory diagnostic; a fresh
directory is allowed to configure normally. The validator never edits or removes the caller's cache.
`crates/bunwasm-crypto-sys/build.rs` checks before configure and build; the original shared shell
adapter `scripts/check-wasi-cmake-cache.sh` covers `jsc/configure.sh`, `jsc/build.sh`, and
`scripts/real-runtime-network-tls.sh` before shim, configure or Ninja work. Regression fixtures use
actual C/C++ Ninja caches, cover matching reuse and compiler/toolchain/target/system/processor/
sysroot mismatches, deleted toolchain files, incomplete metadata, and byte-for-byte preservation.
Build-command sentinels verify the real shell entry points refuse mismatches without launching
compilers, Ninja or services. Real configure probes use the existing descendant-safe command
wrapper with a 15-second deadline inside a 30-second integration-test budget, accommodating
cold or contended compiler discovery without unbounded waits.
This is build safety for the wasm port, not a copied CMake implementation.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [CMake toolchain cache preflight](#cmake-toolchain-cache-preflight) | Port | Reject an existing CMake cache whose recorded compiler, toolchain file, target, system, processor or sysroot does not match the requested native or WASI configure/build. |

[Ledger scope and pinned revisions](scope.md).
