### QuickJS

`third_party/rquickjs-sys` is rquickjs-sys **0.13.0**, with its bundled QuickJS-ng. Every change below has class **Host feature**.

| File and area | Change | What breaks without it |
| --- | --- | --- |
| `quickjs/quickjs.c`, parser call locations | Record the callee, property, or constructor position after parsing arguments. | Stack frames and source maps point to QuickJS's argument position instead of Bun/JSC's call position. This is a compatibility policy, not an ECMAScript violation by QuickJS. |
| `quickjs/quickjs.c`, `JS_bunwasm_OwnKeysInOrder` | Return ordinary-object keys in JSC's inspection order, with integer keys sorted and symbols interleaved by insertion. | Bun-compatible console inspection cannot reproduce that order through `Reflect.ownKeys`. |
| `quickjs/quickjs.c`, `JS_bunwasm_IteratorEntries` | Snapshot remaining Map/Set iterator entries without advancing the iterator. | Console inspection either lacks the entries or consumes the user's iterator. |
| `quickjs/quickjs.c`, async context | Store and trace a context value, capture it in promise reactions, restore it for jobs, and expose get/set functions. | QuickJS `AsyncLocalStorage` loses its store across promise and await boundaries. The original engine has no obligation to implement Node's API. |
| `quickjs/quickjs.c`, WebAssembly.Memory buffers | Add a `wasm_memory` ArrayBuffer flag, `JS_bunwasm_NewWasmMemoryBuffer` over bytes QuickJS never frees, and `JS_bunwasm_DetachWasmMemoryBuffer`. Flagged buffers refuse `transfer()` and report themselves non-detachable. | The WebAssembly polyfill must copy the whole guest memory across every call and import callback, which exhausts the 512 MiB guest memory for esbuild-wasm. Without the flag, user code could transfer the buffer away from the memory that owns its bytes. |
| `build.rs` | Add rerun tracking for `quickjs` and `quickjs.bind.h`. | Local C changes can leave Cargo using a stale engine until another input invalidates it. This hook supports our fork. |

The memory readout extends the C header and generated bindings as recorded in [QuickJS memory telemetry](quickjs-memory-telemetry.md). The allocator header change is recorded in [QuickJS memory accounting on WASI](quickjs-wasi-gc-accounting.md). Our Rust engine declares the added functions. The vendored tree keeps Linux x86_64 and wasm32-wasip1 bindings and the C files needed by the library, dropping other targets, shell programs, tests, build tooling, and package metadata. It adds the license copy. These packaging choices do not change retained upstream implementations. Every other retained source file matches the published crate.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, call locations](#quickjs) | Host feature | Match JSC's call-site stack columns. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, inspection helpers](#quickjs) | Host feature | Inspect keys and iterator entries without consuming them. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, async context](#quickjs) | Host feature | Capture and restore async context in promise reactions. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, WebAssembly.Memory buffers](#quickjs) | Host feature | View wasm memory in place; only the polyfill can detach it. |
| [`third_party/rquickjs-sys/build.rs`](#quickjs) | Host feature | Rebuild when the locally patched C sources or binding header change. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
