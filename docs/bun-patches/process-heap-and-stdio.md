# process.memoryUsage heapUsed and the stdio accessors

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-engine-quickjs/src/vm.rs` `collected_heap`, `gc`, `heap_size_after_collection` and `memory_usage` | Original adapter | None |
| `crates/bunwasm-runtime/src/js/process.ts` `guardedStdio` and the `stdin`, `stdout` and `stderr` accessors | Original adapter | None |

Bun's `process.memoryUsage().heapUsed` is the live heap size that JavaScriptCore measured at the end of the most recent collection, and the whole heap before the first one; `Bun.gc(true)` and `bun:jsc` return the figure their own collection measured. JavaScriptCore does this natively. QuickJS counts live bytes at every allocation, so its `Engine::gc` keeps the figure measured right after the collection, `heap_size_after_collection` returns it (the existing hook behind `Bun.gc()`'s result), and `memory_usage` reports it as `heapUsed`, or the whole heap (`heapTotal`) before any collection. Shared JavaScript is unchanged. The Browser engine reports the page's own counters.

Bun's stdio accessors do not crash once the global `process` is replaced (`process = null`). A stream that was already made is returned as before. One that is not made yet fails: the error goes to the uncaught exception handlers (Bun reports it the same way) and the read gives `undefined`.

`tests/fixtures/process-heap-collections` (QuickJS and JavaScriptCore) and `tests/fixtures/process-stdio-replaced-process` compare both behaviors with native Bun.
