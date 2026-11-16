# Bun ArrayBuffer concatenation

Class: Original adapter.

`crates/bunwasm-runtime/src/js/concat_array_buffers.ts` implements the allocation
boundary previously embedded in `bun.js`. Comparison sources are Bun
`src/jsc/bindings/BunObject.cpp` (`functionConcatTypedArrays` and
`flattenArrayOfBuffersIntoArrayBufferOrUint8Array`) and
`test/js/node/buffer-concat.test.ts` at
`9510e74152073d850a18758ca41114d8f214ffa6`, plus native Bun 1.4.4
(`38afee6c84fcf48c0edb2466aa4b27d287a59c30`). No upstream implementation is
copied.

The adapter reads all input getters before measuring the resulting byte views.
It validates those views, measures their intrinsic byte lengths, applies the
numeric maximum before allocation, and copies into one exact backing store.
Allocation failure becomes TypeError with `Failed to allocate ArrayBuffer`,
as in native Bun. The catch covers only the allocation; errors raised while
reading or validating input still propagate. Returning the backing ArrayBuffer
directly avoids a second full allocation.

The existing `internal.toUint8` conversion remains the input adapter. Numeric
maximums retain Bun's UInt32 conversion; NaN and negative maximums throw, and
Infinity leaves the result uncapped. No engine memory limit changes.

The source controls and all-engine public fixture are
`scripts/buffer-allocation-boundaries.test.ts` and
`tests/fixtures/buffer-allocation-boundaries`. Upstream concatenation tests and
expectations remain unchanged.
