## Waffle resolver consumer pin

Class **Host feature**. This is dependency integration and documentation of an original
consumer adapter, not copied or translated resolver code.

The root package, web page, sandbox and optional installed-shell fixture select Waffle
0.0.90 at `c1cb67c300439af24335d0b2ec481bfb52f79a01`, replacing
`c2cc1d318af6791f6b2e3d207cc56df9d7bf542a`. The parent authorized this exact daily
selection after Waffle PR120 and merged-main PUSH run `40173593945`. No Bun package
or Cargo version changes. Matching lock entries belong to the same selection.

The producer inputs are Waffle `browser/net/address.ts`, `browser/net/runtime.ts`,
`index.ts`, `runtime.ts` and `docs/network-lookup.md` at that exact commit. Use the
page's existing runtime: `(await runtime.network()).lookup("localhost", { family: 0,
hints: 0 })` returns a synchronous fresh mutable array of fresh mutable
`{ address: "127.0.0.1", family: 4 }` records. This is Waffle's virtual network policy,
not an OS resolver or a Bun-side localhost constant.

Bun still owns its eventual DNS facade, validation, callbacks, promises, ordering and
native flags-to-hints translation. That facade is separate work. This integration does
not migrate or delete existing socket adapters, change the reserved node-process
188-397 descriptor block or worker-threads provenance, or incorporate unmerged native
socket work. Earlier consumer fixes remain in place. The process-only test fixture
declares the new lookup method with an explicit unexpected-operation failure. Three
network-observation wrappers delegate lookup to their existing capability. They do not
emulate the resolver or supply localhost records; producer runtime policy remains separate.

Prepared Node-conditioned runtime exports require a browser-compatible Worker host.
Native Bun provides a real Worker; plain Node export loadability alone is not full
runtime proof. The producer's exact-tree native Bun proof already covers lookup and
is reused rather than repeated. Consumer type and contract results for this pin are
separate from the earlier PR169 review and browser acceptance. This update does not
claim fresh guest, native, browser or product acceptance.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Waffle resolver consumer pin | Host feature | Consume one parent-selected runtime revision while preserving Bun adapter ownership. |

[Ledger scope and pinned revisions](scope.md).
