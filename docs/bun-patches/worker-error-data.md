## Worker error data

`crates/bunwasm-runtime/src/js/worker_threads.ts::encodeWorkerError` is original
bun-wasm adapter code. It normalizes a formatted `BuildError` to `SyntaxError`,
serializes it through the existing codec, and derives the separate error code
from the value actually encoded. If encoding the original value fails, both the
graph and code come from the replacement `ERR_WORKER_UNSERIALIZABLE_ERROR`.
A second encoding failure still propagates.

The public contract reference is Bun's `src/js/node/worker_threads.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`. No upstream implementation was copied
or adapted for this correction, and no vendor patch is needed. The existing
[worker adapters](worker-threads-adapter.md) retain their separate provenance.

`worker_protocol.d.ts::WorkerErrorData` and the internal `workerErrorData` hook
are original declarations for that pure helper. The declaration-only aliases in
`scripts/worker-error-data-types.d.ts` let the synthetic test use those same
contracts. `scripts/worker-error-data.test.ts` tests encoding and decoding only,
without starting a worker or initializing a control channel. Its single blocking
owner is `checks/runtime-worker-error-data.json`.

The MessagePort constructor guards and worker codec remain unchanged. This
correction does not establish worker startup, transport, loader, or parent-event
behavior.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Worker error data](#worker-error-data) | Host feature | Original pure error-data helper, internal declarations and synthetic regression; retain the encoded fallback's code and normalize formatted build errors. |

[Ledger scope and pinned revisions](scope.md).
