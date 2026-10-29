# vinext example probe

| Source | Class | Origin |
| --- | --- | --- |
| `examples/vinext-probe/pages/index.tsx` | Host feature | Adapted Cloudflare vinext example. |
| `examples/vinext-probe/components/counter.tsx` | Host feature | Unmodified Cloudflare vinext example. |
| `examples/vinext-probe/vite.config.ts` | Host feature | Adapted documented vinext Node configuration. |
| `scripts/app-matrix/vinext-probe.ts` | Host feature | Original bun-wasm test adapter. |

## Upstream source

Repository: https://github.com/cloudflare/vinext, revision
`db25840435a63a55191d7349a3985ba2d4f9370f`, MIT license.
Source paths: `examples/pages-router-cloudflare/pages/index.tsx`,
`examples/pages-router-cloudflare/components/counter.tsx`, and
`examples/pages-router-cloudflare/vite.config.ts`. The repository README at that
revision documents the Node configuration and `vite dev`, `vite build`, and
`vinext start` commands. `examples/vinext-probe/upstream.json` records the pins.

## Local changes and reasons

The home page keeps `getServerSideProps`, `next/head`, and the counter. It removes
navigation to omitted pages and the type-only Next dependency. The title and
heading identify the probe. The counter is unchanged. The Vite config removes the
Cloudflare plugin and uses the documented Node target. No styled-jsx, Next SWC,
Cloudflare credentials, or deployment is involved.

The npm implementation is unmodified vinext 1.4.0, Vite 8.3.4, plugin-react 6.1.0,
and React/React DOM 19.3.1. `bun.lock` pins transitive versions and archive
integrities. The example revision identifies the source adaptation, not a claim
that npm vinext 1.4.0 was published from the current example commit.

## Original adapter

The driver calls existing app-matrix `browserHost`, command checks, HMR probes,
root previews, and registry replay. It creates no new runtime. It records guest
asset hashes and labels all runs diagnostic. A current-source acceptance claim
requires the canonical producer's manifest and verified receipts separately.

[Run the probe](../vinext-probe.md).
