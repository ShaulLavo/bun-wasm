## Strict handwritten stream adapter

Class **Host feature**, original bun-wasm source: `src/js/streams.ts` replaces
`src/js/streams.js` from bun-wasm `ac43127c85addabed7e0c2a4883247ae074e858c`.
This wrapper is not copied from an upstream file. `src/js/runtime.d.ts` describes
the existing native decoder in `src/streams.rs`, portable stream constructors,
compression factory and byte-input validator. Generated `streams_polyfill.js`,
Node stream ports and native codec implementations are unchanged.

The executable delta has two parts. Decoder construction keeps converted label
and options in separate const locals instead of overwriting parameters. Label
conversion still precedes dictionary validation, then reads `fatal` and
`ignoreBOM` once in that order. Prototype enumeration now throws a TypeError
if an enumerated own descriptor is missing, before assignment. It never skips a
member or falls back. This check applies only to the wrapper's private stable
adapter prototypes. All other executable syntax is unchanged after accounting
for these two edits and redundant expression parentheses.

Host engines retain their own text constructors. Portable engines retain native
numeric handles, controller flow, private-field brands, finalizer registration,
release ordering and error identities. Type erasure preserves the final
TypeScript token positions, not every original JavaScript column. The wrapper
suite in `web/tests/runtime-streams.test.ts` is discovered by the existing web
unit command. The native fixture smoke selects `runtime-ts-streams` once.
Evidence and actual emitted-byte accounting are under
`/work/reports/bun-wasm/ts-streams-20261024/`.

The browser interop harness in `scripts/test-native-stream-interop.mjs` reads
and erases `streams.ts` explicitly, just like `compression_streams.ts`. Its old
JavaScript-only discovery silently omitted the renamed wrapper. The pure
`--dump` regression in `scripts/native-stream-inputs.test.ts` checks required
modules and parses the erased stream factory without loading Playwright.
`checks/quality-native-stream-inputs.json` gives this regression one blocking
quality owner. Browser fixtures and assertions are unchanged.

Integration with the typed assertion and utility modules requires one shared
ambient contract for `String.toWellFormed`. Their declaration now matches the
stream declaration's required method; the utility implementation keeps its
feature detection and fallback. No runtime implementation changed.

The strict conversion of `node_stream_bindings.ts` and
`node_stream_internals.ts` replaces the corresponding JavaScript adapters from
bun-wasm `5ea462933fccb6a9788fb8b36cfb170933e3212b`. Both are original
bun-wasm adapters. No Bun or Node implementation is copied. Local contracts
cover Web Stream state, adapter options, writable lifecycle state, destruction
callbacks, promise helpers, and core bundle inputs. The module keys and parsed
runtime syntax stay unchanged.

`scripts/test-native-stream-interop.mjs` now loads the binding through Node's
strip-mode TypeScript emission. `scripts/stream-bindings.test.ts` generates
compile-time probes from the actual factories and checks real Node readable and
writable objects, flattened callable exports, nullish options, typed callbacks,
portable state, brands, promise helpers, and listener cleanup.
The existing runtime and quality manifests own these checks. Emission and
byte-equivalence evidence is under
`/work/reports/wave-20261029/bun/typescript-stream-bindings/`.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/streams.ts`](#strict-handwritten-stream-adapter) | Host feature | Original text-stream wrapper and native codec contracts, with bounded local normalization and descriptor validation. |
| [`crates/bunwasm-runtime/src/js/assert_util_types.d.ts`](#strict-handwritten-stream-adapter) | Host feature | Integration-only alignment of the existing original utility declaration with the required string method used by both adapters. |
| [`crates/bunwasm-runtime/src/js/node_stream_bindings.ts`](#strict-handwritten-stream-adapter) | Host feature | Original Node and Web Stream bindings with strict local state, callback, promise, and bundle contracts. |
| [`crates/bunwasm-runtime/src/js/node_stream_internals.ts`](#strict-handwritten-stream-adapter) | Host feature | Original internal stream adapters with strict state and forwarded-option contracts. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
