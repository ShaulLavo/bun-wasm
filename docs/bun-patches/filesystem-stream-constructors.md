## Filesystem stream constructors

Class **Host feature**. `crates/bunwasm-runtime/src/js/fs_stream_constructors.ts` implements original callable `ReadStream` and `WriteStream` constructors. `node_fs.js` retains only lazy module loading and public export wiring. No Bun, Node, compression, or destroy implementation is copied or adapted. The public reference contracts are Node 26.12.1 `lib/fs.js` and `lib/internal/fs/streams.js`, plus the Bun 1.4.4 executable. Both native controls expose the constructors, inherit from the corresponding Node stream classes, and return those types from their factories.

The constructors lazily initialize through the existing shipped `node:stream` implementation. The factories return the same types, including the `FileReadStream` and `FileWriteStream` aliases. Existing descriptor operations provide deferred open with caller-selected permissions, bounded reads, byte-oriented partial-write completion, byte counters, and close-on-destroy. Explicit close flushes pending writes before destroying the stream when automatic destruction is disabled. The Node stream implementation provides buffering, backpressure, encoding, pipes, async iteration, and lifecycle events. This replaces the previous whole-file EventEmitter facsimiles instead of adding another stream implementation.

The missing exports broke destroy 1.2.0 `index.js` when compression 1.8.2 `index.js` closed a response before creating a compression stream. The cached packages and native controls remain diagnosis inputs only. `scripts/node-fs-stream-constructors.test.ts` runs the production factories with real native descriptors and deliberately short writes. It checks construction, inherited receivers, prototype identity, creation modes, string decoding with `decodeStrings: false`, explicit close with `autoClose: false`, ranges, encoding, backpressure, errors, and descriptor cleanup. This source-factory evidence does not claim React Router application acceptance.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Filesystem stream constructors](#filesystem-stream-constructors) | Host feature | Original TypeScript callable filesystem stream constructors use the shipped Node stream lifecycle and existing WASI descriptor operations. |

[Ledger scope and pinned revisions](scope.md).
