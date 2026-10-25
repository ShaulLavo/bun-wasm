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

An optional Buffer adapter in `WorkerCodecHooks` records a `node-buffer` tuple.
It copies only the Buffer's visible bytes and restores its Buffer type. The
default worker codec has no Buffer adapter, retains its existing Uint8Array
behavior, and rejects a `node-buffer` tuple on decode. The new tuple requires
exact arity and canonical base64. Validation rejects the tag without the hook,
including unreachable nodes and queued graphs. Error encoding and normalization
are unchanged by this adapter.

Native Bun's serializer includes a sliced Buffer's full backing allocation and
drops Error cause in the inspected version. This adapter copies visible Buffer
bytes and retains the existing graph codec's cause behavior. Those are documented
differences, not a claim of byte compatibility or complete Bun parity.

`scripts/v8-serialization.test.ts` compares value behavior with native Bun and
exercises the actual builtin registry and graph codec. It also checks malformed
bytes and Buffer tuples, sliced inputs, and unchanged default codec behavior.
`tests/fixtures/v8-fork-serialization/` sends serialized RPC bytes through a real
fork in both directions. Native Bun passes this fixture. A compiled guest run
and Vitest app acceptance require the coordinator's shared guest producer; host
controls alone do not establish either result.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `v8.ts` and `builtins.js` node:v8 entry | Host feature | Original byte serializer using the worker graph. |
| `worker_codec.ts` Buffer branches and `worker_protocol.d.ts` tuple and optional hook | Host feature | Original opt-in Buffer preservation without changing default worker encoding. |
| `runtime.d.ts` | Host feature | Typed Buffer identity and serializer module contracts. |

[Ledger scope and pinned revisions](scope.md).
