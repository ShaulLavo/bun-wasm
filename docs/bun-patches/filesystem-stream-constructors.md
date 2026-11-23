## Filesystem stream constructors

Class **Host feature** + **Port** (close and custom-write state machines). `crates/bunwasm-runtime/src/js/fs_stream_constructors.ts` implements callable `ReadStream` and `WriteStream` constructors over the shipped `node:stream` classes and WASI descriptor operations. `node_fs.js` retains only lazy module loading and public export wiring. The public reference contracts are Node 26.12.1 `lib/fs.js` and `lib/internal/fs/streams.js`, plus Bun `9510e74152073d850a18758ca41114d8f214ffa6` (`src/js/internal/fs/streams.ts`).

The `ReadStream.prototype.close(cb)` premature-close callback wiring and `WriteStream`'s custom `options.fs` (`open`/`write`/`writev`/`close`/`fsync`), `options.flush`, deferred `_destroy` (`kIsPerformingIO`/`kIoDone`), and short-write retry state machines adapt Bun's `src/js/internal/fs/streams.ts` at `9510e74152073d850a18758ca41114d8f214ffa6`. Local changes compared to Bun's file:
- Options (`options.fs`, `options.flush`, `start`, `end`, and `FileHandle` + `options.fs` rejection) are validated before linking a `FileHandle`, so a rejected constructor leaves the handle usable and closable.
- Missing or `null` custom `write`/`writev` hooks are treated as absent while validating only the hooks that will be called.
- Default-backend `flush: true` runs `fsyncSync(fd)` before closing the descriptor or `FileHandle`, and still closes on sync failure.
- Short-write retries in `writeAllCustom`/`writevAllCustom` preserve `pos === undefined` for cursor-based writes and advance `pos` cleanly for explicit-position writes.

The constructors lazily initialize through the existing shipped `node:stream` implementation. The factories return the same types, including the `FileReadStream` and `FileWriteStream` aliases. Existing descriptor operations provide deferred open with caller-selected permissions, bounded reads, byte-oriented partial-write completion, byte counters, and close-on-destroy. Explicit close flushes pending writes before destroying the stream when automatic destruction is disabled. The Node stream implementation provides buffering, backpressure, encoding, pipes, async iteration, and lifecycle events. This replaces the previous whole-file EventEmitter facsimiles instead of adding another stream implementation.

ReadStream wraps each native read result as a Buffer view. It no longer allocates
a separate destination or copies returned bytes into it. Regular-file tail and
EOF scratch bounds belong to the shared Rust descriptor adapter, using the live
file cursor when no explicit stream start was supplied. Stream ranges, byte
counters and read-error destruction retain their existing contracts.
Large regular-file stream requests reuse the existing 1 MiB native piece limit,
emitting the pieces directly instead of assembling another destination first.
The read itself stays synchronous, but its chunk or end of file reaches `push()`
on a later turn through the callback API's `setImmediate` delivery, as Node's
`fs.read` callback does. Pushing end of file inside `_read` landed while the
previous `'readable'` was still being emitted, so the final `'readable'` (where
`read()` returns null) never fired for a file whose last read was short.

The missing exports broke destroy 1.2.0 `index.js` when compression 1.8.2 `index.js` closed a response before creating a compression stream. The cached packages and native controls remain diagnosis inputs only. `scripts/node-fs-stream-constructors.test.ts` runs the production factories with real native descriptors and deliberately short writes. It checks construction, inherited receivers, prototype identity, creation modes, string decoding with `decodeStrings: false`, explicit close with `autoClose: false`, ranges, encoding, backpressure, errors, and descriptor cleanup. This source-factory evidence does not claim React Router application acceptance.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Filesystem stream constructors](#filesystem-stream-constructors) | Host feature | Original TypeScript callable `ReadStream`/`WriteStream` scaffolding over the shipped Node stream lifecycle and WASI descriptor operations. |
| [`crates/bunwasm-runtime/src/js/fs_stream_constructors.ts`](#filesystem-stream-constructors) | Port | Adapts `ReadStream.prototype.close` and `WriteStream` custom `options.fs`/`_writev`/`flush`/deferred `_destroy`/short-write retry state machines from Bun `src/js/internal/fs/streams.ts` (`9510e74152073d850a18758ca41114d8f214ffa6`). |

[Ledger scope and pinned revisions](scope.md).
