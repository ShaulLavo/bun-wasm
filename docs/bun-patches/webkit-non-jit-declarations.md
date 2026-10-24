### WebKit non-JIT declarations

Files `Source/JavaScriptCore/dfg/DFGAbstractHeap.h`, `Source/JavaScriptCore/runtime/JSModuleLoader.cpp`, and `Source/JavaScriptCore/runtime/VM.cpp` in `jsc/webkit-wasi.patch`. Class **Upstream bug**.

Move `AbstractHeapKind` outside the DFG-only guard because `DOMJIT::Effect` uses it without DFG. Include `<wtf/Scope.h>` in the two translation units that use its helpers. Without these changes the fork's C-loop configuration fails to compile.

This is a judgment call. The build failures are in a non-JIT configuration and do not depend on WASI syscalls or wasm pointer size. They are upstream configuration bugs, although bun-wasm is what needs that configuration. Running the installed native Bun 1.4.2 cannot test missing compile-time declarations. Its default build does not exercise this configuration. A fresh native C-loop build has not been attempted. The owner's ready-to-file report states the source evidence and the unrun native build check separately.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, non-JIT declarations](#webkit-non-jit-declarations) | Upstream bug | Expose a required enum without DFG and add two missing includes. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
