## Node stream core semantics

Class **Port**. `node:stream` ships readable-stream 4.7.0 (`third_party/node-streams`, Node 18.19.0 base), bundled by `scripts/vendor-node-streams.mjs` into `crates/bunwasm-runtime/src/js/node_stream_core.js`. Before bundling, the generator applies the `nodeStreamSemantics` table: exact readable-stream source snippets, each with its expected match count, replaced by the Node 26 behavior Bun 1.4.4 ships in `src/js/internal/streams/` at revision `9510e74152073d850a18758ca41114d8f214ffa6`. A snippet that no longer matches fails generation. The upstream reference test is `test/js/node/stream/node-stream.test.js` at the same revision.

| File | Change | Upstream |
| --- | --- | --- |
| `state.js` | Default byte `highWaterMark` 64 KiB instead of 16 KiB. | Node 22; Bun `state.ts` outside Windows |
| `readable.js` | `pause()` returns without effect on a destroyed stream. | nodejs/node#62557 |
| `readable.js` | `resume()` returns without effect once a destroyed stream emitted `'end'`. | Bun's narrowing of nodejs/node#62557 in `readable.ts` |
| `readable.js` | `read()` without a size returns one buffered chunk when no decoder is set. | Node 26 `howMuchToRead()` |
| `readable.js` | `maybeReadMore` is not scheduled while a `_read` is in flight. | nodejs/node#60454 |
| `writable.js` | A string chunk written with the `'buffer'` encoding throws `ERR_UNKNOWN_ENCODING`. | Node 26 `_write()` |
| `writable.js` | `Writable.prototype[Symbol.asyncDispose]` destroys an unfinished stream with `AbortError`, as `Readable` already did. | Node 26 `writable.js` |
| `duplexify.js` | `Duplex.from({ readable, writable })` destroys the writable side, not the readable side again, when the readable side errors. | nodejs/node#62824 |
| `operators.js` | `compose()` returns the composed Duplex directly, and the composed pipeline's own check reports `streams[1]` for a non-writable destination. | nodejs/node#60907 |
| `operators.js` | Operator callbacks fail with the `validateFunction` message (`must be of type function`). | nodejs/node#59529 |

`crates/bunwasm-runtime/src/js/node_stream_bindings.ts` also supplies Node's `normalizeEncoding` to the vendored Node 26 web stream adapters. readable-stream's util module has none, so `Writable.fromWeb` and `Duplex.fromWeb` called undefined for a string chunk in any encoding but UTF-8. This is an original adapter of Node's `lib/internal/util.js` encoding names.

The generator's adapter binding list drops `ERR_INVALID_STATE` and `validateFunction`, which the adapters never use, so it reproduces the checked-in `node_stream_web.js` again.

Not ported: Node 26's pipeline error ordering (nodejs/node#62113, a real destroy error replacing the AbortError of an aborted signal). Changing only `finishImpl`'s condition let the premature close from readable-stream's older `pipe()` replace the AbortError of an aborted `compose()`. It needs Node 26's `pipeline.js` as a whole.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/vendor-node-streams.mjs` `nodeStreamSemantics`](#node-stream-core-semantics) | Port | Apply Node 26 stream semantics that Bun ships to the vendored readable-stream before bundling. |
| [`node_stream_bindings.ts` `normalizeEncoding`](#node-stream-core-semantics) | Host feature | Node's encoding-name normalization for the vendored web stream adapters. |

[Ledger scope and pinned revisions](scope.md).
