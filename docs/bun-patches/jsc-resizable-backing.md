# JSC resizable ArrayBuffer backing

WebKit is pinned to `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.
These changes are in `jsc/webkit-wasi.patch`.

| Upstream paths | Class | Local change and reason |
| --- | --- | --- |
| `Source/JavaScriptCore/runtime/ArrayBuffer.cpp`, `ArrayBuffer.h`, `BufferMemoryHandle.cpp`, `BufferMemoryHandle.h`, `ArrayBufferView.h` | Port | WASI has no virtual reservation or protection for this backing. A distinct nonshared malloc handle allocates checked initial capacity and grows fallibly. The logical maximum is metadata. Shrink retains capacity and clears truncated bytes. Growth clears exposed bytes with `memset`, then publishes the handle, contents and existing JS/native views before pressure or collection. Failed allocation releases its pending charge; final destruction uses the matching malloc free exactly once. GC estimates retained capacity. |
| `Source/JavaScriptCore/runtime/JSArrayBufferPrototype.cpp` | Upstream bug | Keep resize and transfer lengths wide through coercion and detached checks before checking the destination bound and narrowing on wasm32. A resizability-preserving transfer grows detachable malloc backing before moving contents, so allocation failure leaves the source attached. Fixed destinations retain their separate allocation bound. |
| `Source/JavaScriptCore/runtime/WASIResizableBufferTesting.h` | Host feature | Original adapter, compiled only with `BUN_WASM_JSC_RESIZABLE_TESTING`. The native control can force movement, physical-charge refusal, allocator refusal, pressure and retry, and inspect publication before collection. Production builds contain neither the hooks nor their global state. |

The existing shared-constructor failure guard remains unchanged. The allocator
explicitly rejects shared requests, and shared contents reject this malloc kind.
Fixed SharedArrayBuffer behavior and every ordinary memory maximum remain unchanged.
Freeing returns malloc capacity for reuse; it does not shrink Wasm linear memory.

`tests/native/jsc-resizable-backing.cpp` and
`scripts/jsc-resizable-native.ts` are original test adapters. They compile the
two affected upstream compilation units with test hooks into a separate control,
link against the matching prebuild, and run it three times. Producer archives are
read-only inputs. Feature-owned manifests select the existing native probe and
fixture gates. The fixtures also cover large zeroing ranges, callback coercion,
species, transfer lifetime and the ordinary JSC memory-cap rejection.
