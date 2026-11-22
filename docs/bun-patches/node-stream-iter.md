## Node `stream/iter` experimental builtin

Class **Port** (generated builtin factories) and **Host feature** (flag gating and runtime-provided internal adapters).

Bun ships the experimental `node:stream/iter` module behind `--experimental-stream-iter` (`src/js/node/stream.iter.ts` and `src/js/internal/streams/iter/*.ts` at Bun `9510e74152073d850a18758ca41114d8f214ffa6`). bun-wasm now bundles those generated factories through the existing [builtin loader](builtin-loader-adapter.md) (`crates/bunwasm-runtime/generated/builtins/86.js` to `94.js`, `96.js`, `97.js`, and `174.js`) and gates both Rust module resolution (`crates/bunwasm-runtime/src/resolve.rs`) and JS builtin registration (`crates/bunwasm-runtime/src/js/builtins.js`) on `--experimental-stream-iter` in `execArgv`.

When `--experimental-stream-iter` is absent, `node:stream/iter` and `stream/iter` are not resolved as builtins and are not registered in `builtinFactories`, so `require.resolve.paths("stream/iter")` returns the normal module search paths instead of `null` (`crates/bunwasm-runtime/src/js/bootstrap.js`). When enabled, loading `node:stream/iter` runs Bun's unchanged `src/js/node/stream.iter.ts`, which emits the `ExperimentalWarning`.

The `streams/iter` modules import seven internal Node modules (`internal:errors`, `internal:validators`, `internal:streams/add-abort-signal`, `internal:streams/destroy`, `internal:streams/end-of-stream`, `internal:streams/readable`, and `internal:streams/writable`). Rather than embedding a second copy of Bun's internal Node streams stack, `scripts/bun-builtins.json` lists them under `runtimeProvided` and `crates/bunwasm-runtime/src/js/bun_provided_internals.ts` adapts them onto bun-wasm's existing `node_stream_core` and `node:stream` classes, supplying the `ERR_*` constructors (including `RangeError` for `ERR_INVALID_ARG_VALUE` where `streams/iter` expects it), `aggregateTwoErrors`, and `AbortError` helpers also wired into `bun_builtins.ts`.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/generated/builtins/86.js` to `94.js`, `96.js`, `97.js`, `174.js`](#node-streamiter-experimental-builtin) | Port | Bun's generated `node:stream/iter` and `internal:streams/iter/*` factories, unchanged. |
| [`crates/bunwasm-runtime/src/js/bun_provided_internals.ts`](#node-streamiter-experimental-builtin) | Host feature | Original adapters mapping `internal:errors`, `internal:validators`, and five `internal:streams/*` modules onto bun-wasm's `node_stream_core` and `node:stream`. |
| [`resolve.rs`, `lib.rs`, `bootstrap.js`, `builtins.js`, `bun_builtins.ts`](#node-streamiter-experimental-builtin) | Host feature | `--experimental-stream-iter` gating, `require.resolve.paths` registered-builtin check, and `makeAbortError` / `makeErrorWithCode` delegation. |

[Ledger scope and pinned revisions](scope.md).
