# Root preview origins

Status: Approved. Normal landed dependency adoption and generic consumer work are
implemented. One real browser HTTP-header gate remains blocked in Waffle's generic
dispatcher; parent routed its repair. Review/CI/merge remain parent-owned.

All root peer/dev, web and sandbox contexts now use landed Waffle main
`d3050e73914b7ed4cd72010f72047cce383e2f29`. Its parent is child-cleanup merge
`606275bab3a1e9773f8207e96be49202ea38602d`. Normal Bun resolution generated the locks;
frozen installs and the actual required dispatcher export were checked. No source
archive override, module shim, skipped type check or version bump is used.

## Implemented

- Dedicated loopback roots per runtime owner/virtual port with authenticated
  private owner channels, actual bindHost/dispatcher calls and bounded resources.
- Literal loopback HTTP/WebSocket routing for registered ports, including extra
  ports, with source-owner validation, fixed connection leases, grant readiness,
  resource-conflict rejection and last-owner teardown. No framework rewrite.
- Runtime/page/channel revocation, isolated root cookies and stale-close guards.
- Explicit serving/page setup and maintained --preview-origins harness support.
- Test-only observation of actual forwarded server request lines, caller pathname
  and virtual-port removal after Ctrl-C. Original bytes are forwarded unchanged.
- Current API fixture metadata updates for cwd and cleanup readiness. PR292's
  runtime setup and PR303's ShellFs source correction remain untouched.

## Current gate and assigned runs

The actual native witness sees Origin/Cookie at the host, neither at the native
app, and no installed backend Set-Cookie. Browser Request/Response header guards
in Waffle's generic dispatcher cause this. No Bun CORS/header workaround is added.
The managing chat owns the Waffle repair; consume its landed fix normally.

The worker owns React Router and TanStack root-origin finish-line runs and uses
the parent's immutable qualified normal browser guest at source523e8f45, SHA256
47efa8a23e884cdd772563f99213a3d84a1a3d1580446e98d28b9fff9c020929.
No SolidStart or SvelteKit app run is duplicated. Full consumer review is requested
only after coherent dependency and native header closure. Parent owns CI/merge.

Evidence, actual source paths and cleanup:
`/work/reports/bun-wasm/app-failure-wave-20261027/app-recovery/preview-origin/`.
