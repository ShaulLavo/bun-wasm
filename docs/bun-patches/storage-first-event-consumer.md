# Storage first-event consumer adapter

Classification: original consumer adapter with an adapted test helper.

`scripts/storage-fs-endpoint.ts` adapts Waffle's nonexported filesystem endpoint
observer from PR 511, merge `5cf130c45621c676e593b0e31092baa640ea5e46`.
Its upstream path is `packages/waffle/tests/fixtures/filesystem-endpoint-observer.ts`.
The source is retained in the Storage lane's `firefox-stop-fork-boundary` evidence.
Private imports select the consuming app's installed Waffle. The adaptation adds
bounded observation notifications and preserves the original post result.
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

The Browser guest control checks successful original root, Bun, shell and selected terminal
Preview1 entries. A separate native-port unit control checks the local error path. It makes no Preview1 fault-path, plain-branch, segment-delivery,
or naturally failing native-event claim. Existing storage assertions,
quarantines and secondary evidence/cleanup failures keep their blocking owners.
