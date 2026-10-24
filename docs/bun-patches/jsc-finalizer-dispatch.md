## JSC finalizer dispatch

Class **Host feature**. The additions to `crates/bunwasm-jsc/cpp/helpers.cpp`,
`src/sys.rs` and `crates/bunwasm-runtime/src/engine_jsc.rs` are original adapters.
They call WebKit's existing full-collection and deferred-work APIs. No upstream
implementation is copied or modified. The references are
`Source/JavaScriptCore/API/JSBase.cpp`, `heap/Heap.cpp`, `runtime/VM.cpp`,
`runtime/DeferredWorkTimer.h` and `runtime/JSFinalizationRegistry.cpp` in Bun's
WebKit fork at `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

The public `JSGarbageCollect` API reports an abandoned object graph without
forcing collection. The adapter collects synchronously with the VM's atom table
installed, then restores the calling thread's table. Event-loop microtask draining
also dispatches deferred work, which is where JSC schedules registry callbacks.
Without this dispatch, collected directory owners retain their native cursors.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-jsc/cpp/helpers.cpp`, finalizer dispatch](#jsc-finalizer-dispatch) | Host feature | Original adapter for full collection and deferred cleanup in the wasm event loop. |
