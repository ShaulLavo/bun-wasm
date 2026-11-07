# Native readable-stream iteration

| Class | Local source | Upstream contract | Change |
| --- | --- | --- | --- |
| Original host adapter | `web/src/native-readable-iterator.ts` | WHATWG Streams readable-stream asynchronous iteration | Supply missing `values` and `Symbol.asyncIterator` methods using native default readers. No upstream implementation copied or patched. |

Safari hosts without native stream iteration cannot pass a readable stream to a
consumer that uses `for await` directly. The installer fills missing methods,
reuses an existing callable alias, and leaves complete native implementations
untouched. Newly installed methods share one function. Install after reader
tracking is attached and before iterator tracking wraps these methods.

The adapter validates the native receiver and options synchronously, acquires
its reader immediately, and queues reads and returns without reading ahead.
Completion and read errors release the reader. Return awaits cancellation before
releasing the lock, including on rejection; `preventCancel` releases without
canceling. Holding the lock until cancellation settles is intentional. Node
26.12.1 releases it before settlement. Chunk and return values stay inside result
objects, so promises and thenables are not assimilated. Falsy error reasons are
preserved.

`web/tests/native-readable-iterator.test.ts` uses real native streams with missing
methods shadowed on private subclass prototypes. It covers locking, read and
cancel failures, concurrent operations, early return, options, chunk identity,
and untouched native methods. A Node 26.12.1 comparison checks option conversion
and return-value semantics. These controls do not establish Safari application
success or explain any historical Nuxt failure.
