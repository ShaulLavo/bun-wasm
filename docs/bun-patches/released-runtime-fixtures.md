# Released runtime fixture adapters

| Area | Classification | Upstream source and revision | Local change | Reason |
| --- | --- | --- | --- | --- |
| `web/tests/process-runtime-fixture.ts` and its callers | Original test adapter | Waffle `packages/waffle/fs/protocol.ts` at `63ddc5da0699d6e3ca449eaecb0bc35069c664d9` | Allocate connection request memory through `connectFilesystemIdentity`, then substitute the fixture-owned port | A filesystem identity alone does not contain the connection request pool |
| `web/tests/terminal-output-fixture.ts` and its callers | Original test adapter | Waffle `packages/waffle/browser/terminal-output.ts` at the same revision | Write into the broker-owned ring and dispatch its output notification | Generic workers publish terminal bytes through the bounded output ring |

These adapters call the released APIs. They copy no upstream implementation.
The filesystem adapter closes the temporary pair's ports before returning the
fixture's port. The terminal adapter rejects partial writes so a fixture cannot
silently lose bytes. Its notification remains separate from its write so tests
can prove that completion waits for queued terminal output.

The base-program tests require the release's 24 programs and grant stdout both
write and poll rights. The runtime identity test checks one physical Waffle
installation across Bun, the base families, and the unchanged Bash source pin.
