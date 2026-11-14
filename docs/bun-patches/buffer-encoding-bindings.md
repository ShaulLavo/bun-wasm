# Buffer encoding bindings

`crates/bunwasm-runtime/src/js/buffer_encoding_bindings.ts` is an original
adapter. It implements argument handling for the existing Buffer codecs.
No upstream implementation is copied.

The behavior reference is Bun `src/jsc/bindings/JSBuffer.cpp`, at
`9510e74152073d850a18758ca41114d8f214ffa6`, specifically
`parseArrayIndex`, `jsBufferPrototypeFunction_SliceWithEncoding`,
`jsBufferPrototypeFunction_writeEncodingBody`, and
`jsBufferPrototypeFunction_StringWriteWithEncoding`.
That source identifies Node v26.3.0 `src/node_internals.h`,
`src/node_buffer.cc`, and `lib/internal/buffer.js` as its comparison sources.

Raw slices reject negative indexes and ends beyond the buffer, after the
empty-range check. They accept ArrayBufferView receivers and decode bytes,
including a DataView's byte offset. Public `toString` keeps its clamping policy.
Indexes saturate at the signed 64-bit limit before empty ranges are compared.
Intrinsic length accessors preserve zero length for an already detached
DataView without invoking a receiver's overridden length property.

UTF-8, latin1, and ASCII writers convert offsets and lengths before checking
bounds and rejecting nonstrings. UCS2, UTF16LE, base64, base64url, and hex
writers reject nonstrings first and clamp oversized lengths. These bindings
also distinguish an already detached buffer from detachment during object or
callable argument conversion. They use the existing codecs without copying storage.

The legacy `buffer.js` Port delegates helper installation to this factory.
Both `ucs2` and `utf16le` helper names use the UTF16LE codec. Existing public
`write` and `toString` implementations retain their own argument policies.

`tests/fixtures/buffer-encoding-bindings` supplies bounded checks for native
guests. `scripts/buffer-encoding-bindings.test.ts` runs the same checks against
the actual Buffer factory with TypeScript helpers emitted by the production
transpiler. It compares direct return values and error codes without the
guest's matcher implementation.
