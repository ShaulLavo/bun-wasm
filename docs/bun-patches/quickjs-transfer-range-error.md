# QuickJS transfer length above the maximum

## Source and classification

| Source | Pin | Class |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c`, `js_array_buffer_transfer` | QuickJS-ng 0.16.2 shipped in rquickjs-sys 0.13.0 | Upstream bug |

## Change

`ArrayBuffer.prototype.transfer` on a resizable buffer carries the source's
`maxByteLength` to the new buffer. When the requested length is above that
maximum, ECMAScript's ArrayBufferCopyAndDetach throws a `RangeError`. QuickJS-ng
threw a `TypeError`. The check now throws a `RangeError` with the same message.
Coercion order, detached and immutable checks and every other path are unchanged.

## Verification

`tests/fixtures/resizable-backing` calls `transfer(2 ** 32 + 16)` on a buffer
whose maximum is 131073 and expects a `RangeError` on every engine.
