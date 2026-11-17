# JSC resizable ArrayBuffer backing

WebKit is pinned to `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
These changes are in `jsc/webkit-wasi.patch`.

| Upstream paths | Class | Local change and reason |
| --- | --- | --- |
| `Source/JavaScriptCore/runtime/ArrayBuffer.cpp`, `ArrayBuffer.h`, `BufferMemoryHandle.cpp`, `BufferMemoryHandle.h`, `ArrayBufferView.h` | Port | WASI has no virtual reservation or protection for this backing, and linear memory never shrinks. A distinct nonshared malloc handle allocates exactly the initial length (at least one byte, since null data means detached) and grows fallibly to the larger of the request and 1.5 times its capacity, never above the buffer's maximum, so stepwise growth reallocates a logarithmic number of times. The page-rounded maximum is only `PageCount` metadata. Shrink retains capacity and clears truncated bytes. Growth clears exposed bytes with `memset`, then publishes the handle, contents and existing JS/native views before pressure or collection. Failed allocation releases its pending charge; final destruction uses the matching malloc free exactly once. GC estimates retained capacity. |
| `Source/JavaScriptCore/runtime/JSArrayBufferPrototype.cpp` | Upstream bug | Keep resize and transfer lengths wide through coercion and detached checks before checking the destination bound and narrowing on wasm32. A resizability-preserving transfer grows detachable malloc backing before moving contents, so allocation failure leaves the source attached. Fixed destinations retain their separate allocation bound. |
| `Source/JavaScriptCore/runtime/WASIResizableBufferTesting.h` | Host feature | Original adapter, compiled only with `BUN_WASM_JSC_RESIZABLE_TESTING`. The native control can force movement, physical-charge refusal, allocator refusal, pressure and retry, and inspect publication before collection. Production builds contain neither the hooks nor their global state. |

The existing shared-constructor failure guard remains unchanged. The allocator
explicitly rejects shared requests, and shared contents reject this malloc kind.
Fixed SharedArrayBuffer behavior and every ordinary memory maximum remain unchanged.
Freeing returns malloc capacity for reuse; it does not shrink Wasm linear memory.

Unlike upstream's reserved backing, this backing can move when a resize grows
it. Native code must not hold a resizable buffer's data pointer or span across
user JavaScript (coercion, getters, callbacks) or async work: copy resizable
input first, as `JSHTTPParserPrototype.cpp` does, or take the pointer after the
last point where user code can run. A pin does not stop `resize()`.

`tests/native/jsc-resizable-backing.cpp` and
`scripts/jsc-resizable-native.ts` are original test adapters. They compile the
two affected upstream compilation units with test hooks into a separate control,
link against the matching prebuild, and run it three times. Producer archives are
read-only inputs. The link drops Binaryen from `PATH`, as `jsc/build.sh` does, so
clang keeps the name section that `jsc/finalize.sh` needs. The control never
destroys its VM: VM teardown aborts in `AtomStringImpl::remove` on WASI JSC even
without resizable buffers, and the guest never tears its VM down either. The
control also checks that small buffers allocate only their length, that capacity
stops at the maximum, and that growing to 4 MiB in 4 KiB steps reallocates at
most 24 times. Feature-owned manifests select the existing native probe and
fixture gates. The fixtures also cover large zeroing ranges, callback coercion,
species, transfer lifetime and the ordinary JSC memory-cap rejection.
