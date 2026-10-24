## WASI resizable buffer allocation

Class **Port**. `jsc/webkit-wasi.patch` changes WebKit's
`Source/JavaScriptCore/runtime/ArrayBuffer.cpp` at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
`tryAllocateResizableMemory` returns null on WASI before physical accounting,
virtual page reservation, or protection. WASI does not provide these virtual
backing stores. The unchanged ArrayBuffer and SharedArrayBuffer constructors
turn null into a catchable JavaScript allocation error. Fixed-size buffers
keep their upstream allocation and sharing modes. No JavaScript algorithm is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [WASI resizable buffer allocation](#wasi-resizable-buffer-allocation) | Port | Return a catchable allocation failure before unsupported virtual reservation or protection. |
