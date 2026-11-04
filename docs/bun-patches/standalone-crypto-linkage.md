## Standalone crypto linkage

Class **Host feature**. `crates/bunwasm-crypto-sys/` is the original RSA FFI and build
adapter moved from `crates/bunwasm-runtime/`. It owns the unmodified pinned BoringSSL
archive, libc++ and WASI library search paths. Both the runtime and the parser
support crate depend on it on host and WASI targets. Removing Bun's crypto placeholders requires this dependency
wherever parser support is linked, including the standalone transpiler example.
The archive is linked once through Cargo's `links` identity. The runtime no longer owns
a second native build. `crates/bunwasm-transpiler/build.rs` and `crates/bunwasm-build/build.rs` supply the standalone
example and bundler WASI startup objects because the shared environment disables Rust's self-contained C runtime.
The three obsolete SSL session placeholders in `bunwasm-glue/src/extra.rs` are
removed. They duplicated real libssl symbols when the native TLS tests linked.
Host parser tools now use the same real session ABI instead of unreachable
stand-ins. The existing Cargo dependency identity is unchanged, with no second
crypto producer or build-profile change.
No upstream implementation changed. `scripts/test-transpiler-example.sh` and its mandatory
invocation from `scripts/build.sh` remain unchanged.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-crypto-sys/`, standalone crypto linkage](#standalone-crypto-linkage) | Host feature | Original native archive owner shared by runtime and parser/glue consumers. |

[Ledger scope and pinned revisions](scope.md).
