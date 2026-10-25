## Blob clone adapter

The Blob branches in `crates/bunwasm-runtime/src/js/structured_clone.js` and
`worker_codec.ts`, and the `blob` tuple in `worker_protocol.d.ts`, are original
host adapters. No upstream implementation was copied. The comparison contract is
Bun's `src/js/node/worker_threads.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` and the HTML structured clone behavior
exposed by native Bun 1.4.4 and Node 26.12.1.

The runtime's public Blob keeps its bytes and MIME type in private fields.
Enumerable-property cloning therefore loses them. Structured clone now constructs
a fresh public Blob from those bytes and its type. The worker graph records
base64 bytes and the MIME type, validates the tuple, and reconstructs a public
Blob on decode. The native base64 decoder declaration now describes its owned
ArrayBuffer, matching the native byte-return conversion without an extra copy.
Existing graph memory preserves repeated references. The Blob
constructor copies bytes, so a clone does not share mutable byte storage.

Blob remains cloneable, not transferable. Existing unsupported-value checks and
the prepare/commit boundary for ports and buffers are unchanged. This change
adds no host transport, worker process or port lifecycle machinery.

`scripts/blob-clone.test.ts` runs the complete public Web factory and both
serialization factories. Only native encoding, streams and transfer hooks use
host controls. It verifies nested values, cycles, bytes, type, Blob methods,
malformed tags and failed-transfer atomicity. This is not compiled guest delivery
acceptance. `tests/fixtures/worker-blob-clone/` supplies the blocking guest check
for MessageChannel delivery before close, workerData, Node Worker and Web Worker round trips before
natural exit or close. The parent integration run owns its three-engine guest results.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `structured_clone.js` Blob branch | Host feature | Original Blob byte/type clone adapter. |
| `worker_codec.ts` Blob branches and `worker_protocol.d.ts` blob tuple | Host feature | Original Blob graph encoding, validation and reconstruction. |

[Ledger scope and pinned revisions](scope.md).
