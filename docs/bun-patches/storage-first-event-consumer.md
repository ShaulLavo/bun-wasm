# Storage first-event consumer adapter

Classification: original consumer adapter with an adapted test helper.

`scripts/storage-fs-endpoint.ts` adapts Waffle's nonexported filesystem endpoint
observer from PR 511, merge `5cf130c45621c676e593b0e31092baa640ea5e46`.
Its upstream path is `packages/waffle/tests/fixtures/filesystem-endpoint-observer.ts`.
The source is retained in the Storage lane's `firefox-stop-fork-boundary` evidence.
Private imports select the consuming app's installed Waffle. The adaptation adds
bounded observation notifications and preserves the original post result.
Frame-inspection failures are reported separately so the original send still runs
and preserves its native result or exception, even if the diagnostic reporter throws.
The extension keeps the first 128 ordered endpoint events and an exact dropped-row
count, following the bounded history approach in Waffle's reviewed Firefox
initial-announcement control. Rows describe sends, successful returns, receives,
native errors, and native close calls, returns, and errors. Original close receivers,
argument tuples, results, and exceptions are preserved too. The existing handler
qualification and close boundaries publish complete histories without per-frame output.
No Waffle package source, export or release pin changes.

Build hooks read Waffle 0.0.131 at `5515535c372ea4b7c93bd90ceda3cf4756ef9373`:
`fs/client.ts`, `fs/service.ts`, `runtime.ts`, and `browser/shared-fs.ts`.
They add observation around the original port setup, transport-error check,
runtime return, and connection-alias handoff. The installed Bash entry is
`src/runtime/worker.ts` at `e6d29598eb0111f16bc3068ad52a9167dac51da7`.
Its hook reads process identity before the original bootstrap call.
These transformations affect only the consumer bundle, preserving installed files.

`scripts/storage-fs-build.ts`, `storage-fs-observation.ts`,
`storage-fs-worker-prelude.ts`, and `storage-fs-page-prelude.ts` are original adapters.
The ordinary Browser guest site builder includes them. Deployed product builds omit them by default.
Observation is activated only in a storage test's BrowserContext. Other contexts
retain the original handlers, constructors, executor, preopen and serving path.
Context activation is awaited during protected setup. Installation failure stays
on that primary setup path rather than becoming a late teardown error.

The build adapter installs the helper before original client/service port handlers.
It also checks shared closure at the client's existing transport-error check.
Native process entries read their actual process identity before bootstrap.
Page clients carry no process ID. A document UUID and original filesystem backing
scope every runtime token. The original runtime object binds to that token after
construction. Actual native Worker instances have separate IDs and raw URLs.
A private MessagePort carries only metadata to the owning page.

Each document keeps at most 32 recent metadata rows and emits at most 16 local open-transport failure
records, followed by one explicit overflow marker to the existing storage progress artifact. Stale retirement and propagated closures stay in the ring without consuming
the local failure quota. On assertion failure, the host retains up to eight separate
page streams of 32 rows each and reports dropped rows or streams. Local messageerror, send failure, received
transportClosed and previously shared closure stay distinct. Trust and the first
observed close reason do not prove the native initiating cause. Request payloads,
file contents, request argument strings and guest buffers are never retained.

First-event records also read the failed identity's `revocations[0]`, service
`ownerStates[0]`, and the connection's owner-state word before original handlers.
Those immutable scalar samples remain separate from `closedBefore`, which reads
only the request transport error. A null scalar means unavailable, never unrevoked.
Each later snapshot reads current state separately. The page's existing Worker
post hook records call and return or error order for the actual `connect` service
port transfer, with owner, request generation, and transfer-list membership.
Client bootstrap transfers are not substitutes. Native Firefox port UUIDs are
unavailable and remain null. Page transfer order and service endpoint order are
separate sequences, not a total cross-realm order.

`storage-fs-metadata.ts` is an original retention adapter shared by the page and
host. Their existing 32-row rings replace older snapshots of the same endpoint
with its complete history. Failure retention therefore includes the matched
service's latest history when it remains within that quota. Evicted endpoints,
dropped history rows, and causal-emission overflow remain explicit. Host bounds
remain eight pages, 32 rows per page, and 32 KiB per incoming metadata row.
Failure retention emits one final bounded snapshot after owned cleanup so that
metadata received after the primary failure is retained too.

The Browser guest control checks successful original root, Bun, shell and selected terminal
Preview1 entries. A separate native-port unit control checks the local error path. It makes no Preview1 fault-path, plain-branch, segment-delivery,
or naturally failing native-event claim. Existing storage assertions,
quarantines and secondary evidence/cleanup failures keep their blocking owners.
