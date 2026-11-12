### WebKit module specifier root

File `Source/JavaScriptCore/runtime/JSModuleLoader.cpp` in `jsc/webkit-wasi.patch`, at WebKit `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Class **Port**.

`JSModuleLoader::resolve(JSGlobalObject*, const Identifier&, const Identifier&, ...)` creates a string for the import specifier, then a string for the importing module's name, and passes both to the host's resolve hook. The patch holds the first string in a `Strong<Unknown>` handle while the second is allocated. The handle is guarded by `OS(WASI)`.

Without it, the second allocation can start a collection that frees the first string. JavaScriptCore finds stack values by scanning linear memory, and `wasm-opt --spill-pointers` (`jsc/finalize.sh`) copies only pointer-sized `i32` locals there. A `JSValue` is 64 bits wide, so the compiler keeps it in an `i64` local that the pass skips. In the finalized engine the specifier value was the only reference to its string across the second `JSString::create` call. The hook then read a swept cell. It usually saw an empty string and reported `Cannot find package ''`. It could also trap or throw `RangeError: Out of memory`.

A native build does not have this problem, because its collector scans machine registers and the real stack. That makes this a port change, not an upstream bug.

The failure needs a collection between two adjacent allocations, so it depends on the exact allocation history. TanStack Start's production server hit it on the first request in both Chrome and Firefox. Loading the same modules outside a request did not.

`tests/fixtures/esm-import-specifier-collection` covers it. It runs child processes with JavaScriptCore's `JSC_slowPathAllocsBetweenGCs` option while one module resolves 20000 distinct specifiers. Before the patch, two or three of its four children failed in each run on the CI-built guest from `b1b908b2a1c78c679ede511366f24fd6d635fa78`. Which children fail varies between runs.

This patch roots one value. It does not change the spill pass, so another `JSValue` held only in an `i64` local across an allocating call would have the same exposure. The other fresh values in `JSModuleLoader.cpp` are passed straight to a callee, which stores them in the caller's frame. Other files were not audited.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, module specifier root](#webkit-module-specifier-root) | Port | Root the import specifier string while the referrer string is allocated. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
