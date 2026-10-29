# Released runtime fixture adapters

| Area | Classification | Upstream source and revision | Local change | Reason |
| --- | --- | --- | --- | --- |
| `web/tests/process-runtime-fixture.ts` and its callers | Original test adapter | Waffle `packages/waffle/fs/protocol.ts` at `ea051e5e9061bcd2bfed6faf363be0f21d211acc` | Allocate connection request memory through `connectFilesystemIdentity`, then substitute the fixture-owned port | A filesystem identity alone does not contain the connection request pool |
| `web/tests/terminal-output-fixture.ts`, its callers, and `web/tests/fixtures/telemetry-environment-worker.ts` | Original test adapter | Waffle `packages/waffle/browser/terminal-output.ts` at the same revision | Write into the broker-owned ring and dispatch its output notification | Generic workers publish terminal bytes through the bounded output ring |

These adapters call the released APIs. They copy no upstream implementation.
The filesystem adapter closes the temporary pair's ports before returning the
fixture's port. The terminal adapter rejects partial writes so a fixture cannot
silently lose bytes. Its notification remains separate from its write so tests
can prove that completion waits for queued terminal output.

The process-only fixture rejects directory-lease requests as unexpected
filesystem operations. Tests that need a directory lease use the real runtime.

The telemetry worker uses blocking ring writes for admitted children so the
page can grant output credit through its ordinary notification.
The direct page-root runner uses its existing stdout message transport. This
fixture tests both current launch paths and selects the transport from the request.

The base-program tests require the release's 24 programs and grant stdout both
write and poll rights. The runtime identity test checks one physical Waffle
installation across Bun, the base families, and the unchanged Bash source pin.
