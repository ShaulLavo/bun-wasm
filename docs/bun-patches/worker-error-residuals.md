## Worker error residual source

This records the five remaining source hunks from the worker-error correction.
The bootstrap's missing-entry branch keeps the main-entry diagnostic and adds
`MODULE_NOT_FOUND` when the existing worker error hook is present. The builtin
registry and Rust resolver both recognize `trace_events`, whose factory throws
`ERR_TRACE_EVENTS_UNAVAILABLE` because this host has no tracing agent.
The process adapter rejects `execve` in workers. On the main thread it warns
once and reports that replacing the process image is unavailable.

These are original bun-wasm adapters, not copied upstream implementations.
The contract references are Bun `src/jsc/bindings/BunProcess.cpp:1914-1935`
and `src/js/node/trace_events.ts:1-4` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`. The former's Windows unsupported
branch supplies the diagnostic contract for WASI, not an implementation of
process replacement. Bun's tracing implementation is not imported.

The accepted missing-entry error body in `bootstrap.js` and the additions in
`builtins.js` remain exact. The residual reverses only the authorized stdin
existence exemption before checking the original missing-entry AST fingerprint.
The two process additions move unchanged into the already-typed `process.ts`.
`worker_protocol.d.ts` adds only the existing module's boolean `isMainThread`
export to the `require("worker_threads")` result. An erased local process view
also admits its already-implemented warning method, without changing the method
or its input types. Neither declaration change affects transport,
error payloads, environment hooks or worker lifecycle.

The process source test reverses the two additions before checking its original
AST fingerprint. Its compiler tests cover the new boolean view. The separate
residual test checks syntax fingerprints and resolver registration. Its extracted
main-entry function checks ordinary and worker error codes, messages and plain-error
markers, plus the exact stdin sentinel's lookup exemption. Mutation controls reject
a broader exemption, a disabled worker branch and a changed worker error code.
These source checks do not qualify worker delivery,
loader execution, process replacement or tracing. The separate worker error-data
normalization and fallback are not part of this source checkpoint.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Residual source adapters](#worker-error-residual-source) | Host feature | Original missing-entry diagnostic, unsupported tracing registration and unsupported execve adapters. |
| [Type and source-test adapters](#worker-error-residual-source) | Host feature | Original boolean module view, AST preservation controls and source-only regression checks. |

[Ledger scope and pinned revisions](scope.md).
