# Root preview origins

Status: Approved. Consumer implementation and staged native/browser proof are
complete. Parent owns the remaining landed Waffle pin adoption, full review,
CI, merge and exact application acceptance.

The staged Waffle source is PR160 at
`277bd9a4963b1bf59fc4aa4b3dcf6ba724cb498f`. Its real relay implements the published
`PreviewHostDispatcher`. No dependency manifest or lockfile has adopted this
unmerged source. There is no remaining implementation API or type blocker.

## Implemented

- Bounded loopback addresses and origins per runtime owner and virtual port.
- Same-origin one-use bootstrap tickets and authenticated private owner channels.
- Waffle Open/Input/Output/Exchange payloads with Bun-owned native framing.
- Actual `bindHost` relay dispatch, unchanged paths, streaming HTTP, raw upgrades,
  cancellation and fixed owner/port/origin authorization.
- Runtime-owned page adapters, page/channel disconnect revocation, origin and
  cookie isolation, port reuse and stale-close protection.
- Explicit `PREVIEW_ORIGINS=1` serving, `?root-previews` page setup and maintained
  `--preview-origins` harness support. Static mounted mode remains explicit.
- Native tests and an independent native Bun fixture driven through a real
  browser page runtime and real Waffle relay. No guest or React Router rerun.

Files stay in the serving/preview/harness area. PR293 worker startup and PR294
shared-object activation hunks are unchanged. No Waffle implementation, shell,
engine, CI workflow, dependency pin or version changes.

## Landing and acceptance

1. Parent adopts the Waffle revision only after it lands green.
2. Parent runs one full review of the complete consumer PR and required checks.
3. Parent merges the Bun consumer change.
4. Rerun the exact React Router app only after both changes have landed.

Evidence and rerunnable commands:
`/work/reports/bun-wasm/app-failure-wave-20261027/app-recovery/preview-origin/`.
