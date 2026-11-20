# Process memory figures and `process.report`

Class **Port**. No Bun source is copied. The memory figures `process`, `Bun.gc` and `bun:jsc`
report, and `process.report.getReport()`, follow Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6`:

| Upstream | Behaviour reproduced | Where |
| --- | --- | --- |
| `src/jsc/bindings/BunProcess.cpp` `Process_functionMemoryUsage`, `Process_functionMemoryUsageRSS` | `process.memoryUsage()` has exactly Node's five enumerable numbers. `rss` is the guest's resident memory: the core's linear memory size, which the core reads itself (`linearMemoryBytes`) on all three engines, the Browser engine included, without walking the engine's heap; `memoryUsage.rss()`, `resourceUsage().maxRSS`, `availableMemory()` and `bun:jsc` `memoryUsage()` take only that read. An engine counter it cannot measure reads 0. The engine extensions (`wasmCapacity`, `arrayBufferCount`, `failedAllocation`) stay readable as non-enumerable properties | `crates/bunwasm-runtime/src/js/process.ts` `memoryUsage`, `residentBytes` |
| `Process_functionMemoryUsage` `heapUsed`, `BunClientData.h` `HeapSizeAfterLastCollection` | On JSC, `heapUsed` is the heap size measured at the end of the most recent collection, eden or full (`Heap::sizeAfterLastCollection`), and the whole heap before the first collection | `crates/bunwasm-engine-jsc/src/vm.rs` `memory_usage` |
| `src/jsc/bindings/bindings.cpp` `JSC__VM__runGC`, `src/jsc/modules/BunJSCModule.h` `functionFullGC`, `functionEdenGC`, `functionGCAndSweep` | `Bun.gc()` and `bun:jsc`'s `fullGC`, `edenGC` and `gcAndSweep` return the heap size the collection measured, which `heapUsed` then reports. Every bun-wasm collection is a full one | `crates/bunwasm-runtime/src/js/bun.js`, `builtins.js` |
| `BunJSCModule.h` `functionMemoryUsage` | `bun:jsc` `memoryUsage()` returns `current`, `peak`, `currentCommit`, `peakCommit` and `pageFaults`. Linear memory never shrinks and is all committed, so all four sizes are the current resident size | `builtins.js` |
| `BunProcess.cpp` `Process_functionResourceUsage`, `Process_availableMemory` | `resourceUsage().maxRSS` is the peak resident size in kilobytes, the current size for the same reason; `availableMemory()` is the rest of the 4 GiB address space | `process.ts` |
| `BunProcess.cpp` `constructProcessReportObject`, `Process_functionGetReport` | `process.report.getReport()` returns Node's report sections. `javascriptStack.stack` lists the caller's frames as `error.stack` names them, under the message `Error [ERR_SYNTHETIC]: JavaScript Callstack`. `resourceUsage.rss` and `maxRss` are bytes. Sections a guest cannot observe (native stack, libuv handles, CPUs, network interfaces, shared objects) are empty | `crates/bunwasm-runtime/src/js/process_report.ts` |

## Differences from native Bun 1.4.4

- QuickJS reference counting frees most objects at once, so its `heapUsed` is the live size,
  not a figure from the last collection; Browser's `heapUsed` is the host's `usedJSHeapSize` or 0.
- On JSC `process.memoryUsage()` itself still refreshes the engine's memory record, which
  measures `Heap::size()` by walking the heap, as on main.
  The upstream `heapUsed reports the most recent collection` tests describe JSC's collector and
  pass only on JSC.
- `arrayBuffers` on Browser is 0: a page cannot measure its ArrayBuffers. On JSC the figure
  comes from the same `Heap::arrayBufferSize()` as Bun's, which a collection prunes, so it can
  drop below an earlier read plus a new buffer when the allocation triggers a collection.
- `process.report.writeReport()` and the report options' effects are not implemented.

## Tests

The native fixture `process-memory-report` holds native Bun's output and runs on all three
engines. `process-wasm-capacity` checks that `rss` is the linear memory and `wasmCapacity` stays
off the enumerable keys. `scripts/runtime-process.test.ts` checks the derived figures against the
runtime source.

[Ledger scope and pinned revisions](scope.md).
