# JSC typed-array length conversion

Class: Port.

`jsc/webkit-wasi.patch` changes
`Source/JavaScriptCore/runtime/JSGenericTypedArrayViewConstructorInlines.h`
at WebKit `3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

Both primitive-length constructor entry points assigned ToIndex's uint64 result
directly to size_t. On wasm32, `new Uint8Array(2 ** 32 + 1)` consequently returned
a one-element view. The local helper preserves the wide result, propagates
ToIndex exceptions, checks representability in size_t, and only then narrows.
An unrepresentable length raises the engine's existing Out of memory RangeError.
Small lengths and engine memory maxima keep their existing behavior. The
resizable ArrayBuffer allocator is a separate patch section, recorded in
[jsc-resizable-backing.md](jsc-resizable-backing.md), and this change leaves it
untouched.

The standalone JSC shell control first reproduces truncation on current main.
`tests/fixtures/typedarray-index-length` then checks the production JSC guest
across all twelve typed-array constructors, along with small fractional, NaN
and negative-zero lengths. This fixture is specific to the wasm32 JSC boundary;
64-bit Browser engines can legitimately support larger typed arrays. Original
control code is local, with no upstream expectations or snapshots rewritten.
