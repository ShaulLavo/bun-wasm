## Worker error data

`crates/bunwasm-runtime/src/js/worker_threads.ts::encodeWorkerError` is original
bun-wasm adapter code. It normalizes a formatted `BuildError` to `SyntaxError`,
serializes it through the existing codec, and derives the separate error code
from the value actually encoded. If encoding the original value fails, both the
graph and code come from the replacement `ERR_WORKER_UNSERIALIZABLE_ERROR`.
A second encoding failure still propagates. The sideband accepts only string
codes. A non-string code or a throwing code getter is omitted without replacing
an otherwise cloneable diagnostic.

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

The Error branches in `worker_codec.ts` are also original adapter code. Encoding
converts the message to a string, treats a non-string name as `Error`, and stores
a non-string stack as `null`. That null slot survives JSON transport and decodes
to an absent stack, while an empty string remains an empty stack. Decoding uses
only own properties of the standard Error constructor table. Unknown names,
including names inherited from `Object.prototype`, become `Error`; arbitrary
custom names are not restored. Causes still pass through graph encoding, so an
uncloneable cause still selects the unserializable-error fallback. Incoming
graph validation accepts only normalized names, messages and string-or-null
stacks. No protocol version or old-shape fallback was added.

The same codec separately treats the exact `process.env` object as a plain
object before proxy and tag rejection. Ordinary proxies remain uncloneable.
Blob fields, transfer commit ordering, and MessagePort constructor guards are
unchanged.

The native behavior controls use Bun 1.4.4, revision
`38afee6c84fcf48c0edb2466aa4b27d287a59c30`. Real Bun workers and Bun's
`structuredClone` retain stackless diagnostics, convert numeric messages to
strings, and normalize custom and prototype-like Error names to `Error`.
`scripts/worker-codec.test.ts` and `scripts/worker-error-data.test.ts` compare
those fields against Bun's actual `structuredClone`, including a JSON graph
round trip. They also check malformed graphs, standard constructors, and the
uncloneable-cause fallback. This is source-level conformance evidence, not a
qualified guest, startup, loader, or parent-event transport result.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Worker error data](#worker-error-data) | Host feature | Original error-data helper, Error codec normalization and declarations; retain diagnostic and string-code sidebands, normalize Error fields and constructor names, reject malformed graphs, and preserve fallback for uncloneable causes. |

[Ledger scope and pinned revisions](scope.md).
