# JSC typed-array length conversion

Class: Port.

`jsc/webkit-wasi.patch` changes
`Source/JavaScriptCore/runtime/JSGenericTypedArrayViewConstructorInlines.h`
and, in a separate section, `setFromArrayLike` in
`Source/JavaScriptCore/runtime/JSGenericTypedArrayViewInlines.h`, at WebKit
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`.

On wasm32, `size_t` is 32 bits. Several constructor paths stored a 64-bit
ToIndex or ToLength result straight into `size_t`, so lengths and offsets of
2^32 or more wrapped around: `new Uint8Array(2 ** 32 + 1)` and
`new Uint8Array(buffer, 0, 2 ** 32 + 1)` both gave a one-element view, and
`new DataView(buffer, 2 ** 32)` gave a view at offset 0. Each site now keeps
the wide value, runs the checks that come before it in 64 bits, and narrows only
once the value is known to fit. The thrown error is the one a 64-bit build
throws for the same arguments (native Bun 1.4.4):

| Site | Unrepresentable value | Error |
| --- | --- | --- |
| Primitive length, both constructor entry points | length | RangeError: Out of memory |
| Array-like `length` (ToLength) | length | RangeError: Out of memory |
| Buffer `byteOffset` / `length` | either | Same order as 64-bit: the byteOffset modulo check, then detached TypeError, then the resizable `byteOffset exceeds source ArrayBuffer byteLength`, the `not a multiple of the element size` check, or `Length out of range of buffer` |
| DataView `byteOffset` / `byteLength` | either | The existing 64-bit comparisons against the buffer length, unchanged in order |
| `TypedArray.prototype.set(arrayLike)` source `length` (ToLength) | length | RangeError: Range consisting of offset and length are out of bounds |

Values are never saturated to `SIZE_MAX`, because that would change which check
fires first (for example the byteOffset modulo check). Small values and engine
memory maxima keep their existing behavior.

`ArrayBuffer.prototype.transfer` and `transferToFixedLength` need no change
here. Upstream WebKit at this pin stores the new length in `size_t`, but this
repository's resizable ArrayBuffer section
([jsc-resizable-backing.md](jsc-resizable-backing.md), from #888) already reads
it as `uint64_t` and compares it with `MAX_ARRAY_BUFFER_SIZE` before narrowing,
so 2^32 + 1 throws Out of memory. This change leaves that section untouched.

A search of the pinned typed-array, DataView, ArrayBuffer and Atomics sources
for ToIndex and ToLength results finds no other narrowing. The ArrayBuffer
constructor, `resize`, Atomics and DataView get/set read into `uint64_t`.
The relative-index arguments (`set` offset, `slice`, `subarray`, `fill`,
`copyWithin`, `indexOf`, `with`) clamp in `double` before converting.

`tests/fixtures/typedarray-index-length` checks the production JSC guest across
all twelve typed-array constructors (with small fractional, NaN and
negative-zero lengths), buffer offsets and lengths, DataView, array-like
lengths, `set` from an array-like and transfer. Its expected errors were taken from native Bun 1.4.4.
The fixture is specific to the wasm32 JSC boundary, because 64-bit engines can
allocate a 2^32-element typed array. The control code is local, and no upstream
expectations or snapshots were rewritten.
