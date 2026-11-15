# JSC access-time stack formatting

Classification: Port of upstream source with an original embedding callback.
The upstream is WebKit `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

`jsc/webkit-wasi.patch` changes these upstream paths:

- `Source/JavaScriptCore/runtime/VM.h` adds a WASI-only callback for a materialized
  error's raw stack value. It is separate from the live-frame formatting hook.
- `runtime/ErrorInstance.h` and `runtime/ErrorInstance.cpp` wrap native error-info
  materialization on WASI with Bun additions enabled. The existing native body is
  unchanged. The callback runs after it has produced properties, including after
  GC cached text or when no stack property exists. It runs once, outside the
  immutable-property scope, and never from collection-time `computeErrorInfo`.

Other builds retain the original materialization function. When no callback is
installed the WASI wrapper returns the original result. The bridge and JavaScript
adapter below are original bun-wasm code, with no upstream implementation copied:

- `crates/bunwasm-jsc/cpp/helpers.cpp` forwards the raw value to the existing
  runtime formatter. It no longer computes text from live frames.
- `crates/bunwasm-runtime/src/js/stack_trace.ts` leaves native values untouched
  when no custom hook is installed. This includes the absent stack property for
  an empty trace. Custom hooks still receive an array, including an empty array,
  and successful results use the existing memoization and reentrancy guard.

The native frame collector remains weak. Collection caches strings without
executing JavaScript; later property access invokes the custom formatter.
`tests/fixtures/jsc-stack-materialization` exercises full collection, empty
traces, lazy invocation, memoization and default text/property preservation.
