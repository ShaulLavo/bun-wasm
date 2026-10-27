# Root preview origins

Status: Approved, implementation in progress.

Claim: `web/preview-origin-host.ts`, `web/tests/preview-origin-host.test.ts`,
`web/serve.ts`, `web/src/preview.ts`, and the additive app-matrix hosting adapter.
No worker startup, shared-object activation, engine, shell, or Waffle changes.

Waffle dependency: PR160 currently contains only `docs/preview.md` at d18a23f.
Need its exported authenticated owner-relay constructor and resulting fixed-owner,
fixed-virtual-port host HTTP/WebSocket handler, plus the page connection and close
contract. Bun will supply a bounded loopback listener per owner/port and pass the
published `originForPort` option. No duplicate wire protocol will be invented here.

The exact React Router app rerun stays held until both source changes are concrete
and landed. Independent native HTTP/WebSocket host-boundary tests run first.
Parent owns independent review, CI, and merge.

Checkpoint: Waffle PR160 now has source at `a95cde9a`. Root options, `bindHost`,
and the direct relay are published. The remaining dependency is the documented
`dispatch(open: PreviewHostOpen, exchange: PreviewHostExchange): Promise<void>`
on `PreviewHostRelay`. The exported dispatcher interface exists, its implementation
and attachment to the relay do not. The Bun wrapper accepts inherited options;
server/page transport wiring waits for that exact exported method.
