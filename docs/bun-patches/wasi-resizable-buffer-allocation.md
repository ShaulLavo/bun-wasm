## WASI resizable buffer allocation

Class **Port**. `jsc/webkit-wasi.patch` changes WebKit's
`Source/JavaScriptCore/runtime/ArrayBuffer.cpp` at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
On WASI, `tryAllocateResizableMemory` returns null only for shared requests,
before physical accounting, virtual page reservation or protection. WASI does
not provide the virtual backing stores that growable SharedArrayBuffers need,
and the unchanged SharedArrayBuffer constructor turns null into a catchable
JavaScript allocation error. Non-shared resizable ArrayBuffers get a malloc
backing instead, recorded in [JSC resizable ArrayBuffer backing](jsc-resizable-backing.md).
Fixed-size buffers keep their upstream allocation and sharing modes. No
JavaScript algorithm is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [WASI resizable buffer allocation](#wasi-resizable-buffer-allocation) | Port | Return a catchable allocation failure for growable shared buffers before unsupported virtual reservation or protection. Non-shared requests use the [malloc backing](jsc-resizable-backing.md). |

[Ledger scope and pinned revisions](scope.md).
