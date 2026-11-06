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
Concrete web streams use the original body adapter's direct default-reader loop,
including on hosts without ReadableStream async iteration. Node streams and
generic asynchronous and synchronous iterables still use their existing iteration
protocols without wrapping or changing chunk semantics. The reader adapter keeps
Promise-valued chunks intact and preserves rejection identities. It awaits
cancellation on consumer failure, then releases its lock before the caller sees
the original failure. Completion and read rejection release without cancellation. The existing
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

The reader path was added after actual Safari 26.5 page and worker controls found
neither Symbol.asyncIterator nor values on native or adapted ReadableStreams.
Direct reader controls passed, while this module's text and blob threw the same
TypeError seen in a Nuxt SSR payload. That capability page was secure but not
cross-origin isolated. It identifies the failing consumers, not the exact loop
reached by Nuxt. The Request and Response controls used the first reader-backed
candidate and passed; they were not original-guest controls.

`scripts/body-consumer.test.ts` runs the actual factories with real native readers,
including missing iteration, errors, locks, cancellation and generic iterables.
`build-body-consumer-probe.ts` emits portable baseline and candidate page and worker
controls without patching any host prototype. `body-reader` is the focused guest
fixture for the same reader-backed paths across QuickJS, JSC and Browser guests.

Generate new portable controls into an empty directory with
`bun scripts/build-body-consumer-probe.ts OUTPUT [BASELINE_COMMIT]`.
The default baseline is `3e5fb36d9a22ffd59c40bc4d9552fcf07faa6d71`.
The tool refuses to overwrite packets that another run may still consume.
