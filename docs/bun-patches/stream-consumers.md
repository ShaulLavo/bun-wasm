# Stream consumers

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/stream_consumers.ts` | Adapted upstream implementation | Bun `src/js/node/stream.consumers.ts` at `9510e74152073d850a18758ca41114d8f214ffa6` |
| Factory registration and resolver entry | Original adapter | `builtins.js` and `resolve.rs` |

The module adapts Bun's portable `for await` implementations of `blob`,
`arrayBuffer`, `buffer`, `text`, and `json`. It exposes Bun's `bytes` export through
the same array-buffer conversion. The upstream file's SHA-256 is
`5558c0dfc267a1816cbafc3f90a65cddcb031f1e39f23c1ecea5af689894defd`.

Bun's JSC-only `$inheritsReadableStream` checks and native fast paths are omitted.
Both web and Node streams use their existing async iterators, including error
propagation, iterator closing, cancellation, and reader-lock release. The existing
Blob, Buffer, and TextDecoder supply byte conversion and UTF-8 decoding. Text is
decoded incrementally and flushed at EOF. Binary consumers collect parts because
their result contains the entire body. No Response wrapper or new native codec is
introduced.

This path follows Node's behavior when strings interrupt an incomplete UTF-8 byte
sequence, and when a web stream supplies an invalid text chunk. Native Bun 1.4.4's
web fast path differs: it decodes the interleaved example as `�x��` instead of
`x€`, and collects an invalid numeric chunk until the source ends or errors.
Bun's portable iterable path agrees with Node. The oracle tests assert these
differences explicitly.

`scripts/runtime-stream-consumers.test.ts` loads the real bootstrap, builtin
registry, portable web streams, Node streams, Blob, Buffer, and decoder. It checks
public require/import resolution, emitted functions, and actual ESM named/default
exports from the production Rust wrapper generator. Its controls also run against
Node and Bun. `checks/runtime-stream-consumers.json` selects it for runtime CI.

The frozen Prisma 6.17.1 browser trace stops at this missing builtin while loading
its CLI. Its CLI also calls `stream/consumers.text(process.stdin)` for `--stdin`.
These source tests establish module behavior, not Prisma application acceptance.
The independently owned QuickJS WebAssembly export-table blocker remains outside
this change.
