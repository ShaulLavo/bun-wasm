# Guest TLS registry lifecycle

Classification: original adapter.

`crates/bunwasm-runtime/src/lib.rs`, `src/natives.rs`, `src/split.rs`,
`src/js/bootstrap.js`, and `src/tls/` connect the existing six-operation TLS
driver to one process-owned registry. The adapter uses the existing typed
native dispatcher and adds the private `tlsDispose()` operation. No Wasm export,
engine trait, host ABI, socket owner, or process-global BoringSSL cleanup is
added.

The process state snapshots the guest `NODE_EXTRA_CA_CERTS` value and a bounded
prefix of the guest file before application code runs. It passes `Absent`,
`Bytes`, or `Unavailable` into the registry. The native launcher does not read
this trust setting from its own environment or filesystem, and the registry
never rereads the path after startup.

Disposal is once-only and terminal. It drops connections before contexts,
releases lazy bundled roots and pending startup bytes, and makes retained
native closures reject new context or connection allocation. Repeated disposal
is harmless. Typed release remains idempotent for stale IDs. The split runtime
and explicit process exit call the same Rust disposal helper. The bootstrap exit
finalizer calls `native.tlsDispose()` after I/O cancellation and before worker
exit. `web/src/engine-host.js` must make the matching private call from its
existing `EngineHost.exit` finally path; that file remains owned by the
coordinator's serialized source fence.

The direct native tests in `src/tls/tests.rs` cover bounded startup snapshots,
absent versus unavailable files, typed registration, idempotent disposal, and
terminal allocation rejection. They are source-delivered for the existing
Cargo owner to execute after composition. This change does not claim native
TLS execution, host-handle teardown, worker-supervisor cleanup, application
admission, or PR 461 CI.
