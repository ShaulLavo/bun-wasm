# QuickJS array buffer limits and growable SharedArrayBuffers

## Source and classification

| Source | Pin | Class |
| --- | --- | --- |
| `third_party/rquickjs-sys/quickjs/quickjs.c`, `js_array_buffer_constructor3` | QuickJS-ng 0.16.2 shipped in rquickjs-sys 0.13.0 | Host feature |

## Change

- A length QuickJS cannot back (above `INT32_MAX` bytes, the engine's 2 GB limit) throws
  `RangeError: Out of memory`, which is what JavaScriptCore, and so Bun, reports when a typed
  array or ArrayBuffer is too large to allocate. QuickJS-ng threw
  `RangeError: invalid array buffer length`. `new Uint8Array(2 ** 32 + 1)`,
  `new ArrayBuffer(2 ** 32 + 1)` and `new Float64Array(2 ** 30)` now match Bun. Smaller lengths
  that the guest's memory cannot hold already failed with QuickJS's out-of-memory error.
- A growable `SharedArrayBuffer` (`new SharedArrayBuffer(n, { maxByteLength })`) works without
  SharedArrayBuffer allocator hooks. QuickJS-ng refused one with
  `TypeError: growable SharedArrayBuffer requires SAB allocator hooks`. Ordinary bun-wasm guests
  install no hooks, because no other agent can map their buffers (only shared-group guests share
  memory, and they install hooks). Such a buffer now takes its `maxByteLength` bytes from the
  ordinary array buffer allocator when it is created, so `grow()` only moves `byteLength`, as it
  does over the hooks' allocation, and the existing finalizer frees it through the same
  allocator. Shared-group guests keep refusing growable buffers, as before.

The `maxByteLength` limit (`invalid max array buffer length`) and every other path are unchanged.

## Engines

JavaScriptCore reports `Out of memory` already. Its growable SharedArrayBuffers stay refused on
WASI ([WASI resizable buffer allocation](wasi-resizable-buffer-allocation.md)), because WASI has no
virtual memory reservation for them. The Browser engine uses its host's buffers.

## Verification

`tests/fixtures/buffer-length-limits` (QuickJS and JSC) and
`tests/fixtures/growable-shared-array-buffer` (QuickJS and Browser) hold native Bun's output;
both fail on QuickJS without this change.

[Ledger scope and pinned revisions](scope.md).
