## V8 serialization adapter

`crates/bunwasm-runtime/src/js/v8.ts` is an original adapter for the
`node:v8` `serialize` and `deserialize` pair. No upstream code was copied.
The behavior comparison is Bun's `src/js/node/v8.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` and native Bun 1.4.4.

Vitest 3.2.4 uses this pair for its fork-pool RPC messages. The previous builtin
throws before Vitest can collect tests. The adapter encodes the existing worker
graph as UTF-8 bytes in a Buffer. Its format marker identifies bun-wasm data.
It does not read or produce V8 or JavaScriptCore wire bytes, negotiate formats,
or fall back to a second serializer. Both fork processes use the same adapter.

The graph preserves cycles, repeated object identity, undefined, NaN, negative
zero, BigInt, Maps, Sets, typed arrays, and Error type and message. Serialization
does not transfer or detach ArrayBuffers. MessagePorts remain unsupported and
throw rather than becoming empty objects. Deserialization rejects invalid UTF-8, validates the marker and graph, and
respects a byte view's offset and length.

An optional Buffer adapter in `WorkerCodecHooks` records
`["node-buffer", bufferRef, offset, length]`. Distinct Buffer views share one
backing-buffer node. The adapter restores each view with
`Buffer.from(backing, offset, length)`, which shares storage rather than copying.
For Buffer-only backing, encoding trims to the visible bounding range, rebases
offsets, and zeroes uncovered gaps. Unrelated slab bytes are not serialized.
An explicit backing ArrayBuffer or ordinary typed view in the graph preserves
the full backing instead. The default worker codec has no Buffer adapter,
retains its existing Uint8Array encoding, and rejects `node-buffer` everywhere,
including unreachable nodes and queued graphs.

Validation requires own-property view names, exact binary tuple arity, canonical
base64 for ArrayBuffer and Blob storage, valid backing references, aligned and
in-bounds views, and canonical numeric strings. Intrinsic ArrayBuffer brand
checks accept foreign-realm buffers without accepting forged string tags.
Error encoding and normalization are unchanged by this adapter.

Native Bun's serializer includes a sliced Buffer's full backing allocation and
drops Error cause in the inspected version. This adapter copies visible Buffer
bytes and retains the existing graph codec's cause behavior. Those are documented
differences, not a claim of byte compatibility or complete Bun parity.

`scripts/v8-serialization.test.ts` compares value behavior with native Bun and
exercises the actual builtin registry and graph codec. It also checks malformed
bytes and Buffer tuples, overlapping and empty views, explicit-backing
promotion, trimmed gaps, foreign-realm buffers, detached buffers, sliced inputs,
and unchanged default codec behavior.
`tests/fixtures/v8-fork-serialization/` sends serialized RPC bytes through a real
fork in both directions. Its reply rejects if the child exits before sending,
and a bounded early-exit control verifies that it cannot hang. Native Bun passes
this fixture. A compiled guest run
and Vitest app acceptance require the coordinator's shared guest producer; host
controls alone do not establish either result.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `v8.ts` and `builtins.js` node:v8 entry | Host feature | Original byte serializer using the worker graph. |
| `worker_codec.ts` Buffer and validation helpers, `worker_protocol.d.ts` tuple and optional hook | Host feature | Original opt-in Buffer alias preservation and graph validation without changing default worker encoding. |
| `runtime.d.ts` | Host feature | Typed Buffer identity and serializer module contracts. |

[Ledger scope and pinned revisions](scope.md).
