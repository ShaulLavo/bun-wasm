# CI tool bootstrap

Class **Host feature**. `scripts/ci-bootstrap-tools.ts` and
`.github/actions/setup-tools/action.yml` are original host adapters. They replace
acquisition by oven-sh/setup-bun v2 at
`0c5077e51419868618aeaa5fe8019c62421857d6` and actions/setup-node v4 at
`49933ea5288caeca8642d1e84afbd3f7d6820020`, not their product implementations.
The relevant upstream behavior is Bun's `src/action.ts` asset selection and
Node's `src/distributions/base-distribution.ts` manifest selection and extraction.
No upstream source is copied.

The hosted Linux x64 runner's preinstalled Node executes the TypeScript bootstrap.
Node's public versions manifest supplies the same major or exact version selector
already used by each workflow. The archive comes from actions/node-versions through
the authenticated release downloader. Bun remains exactly 1.4.4. Both downloaded
executables must report the selected version before their directories enter
`GITHUB_PATH`. The updater keeps its exact Node 26.12.1 selector. Other jobs retain
Node major 26. Jobs that did not request Node still install only Bun.

This removes the actions' public-release download calls without changing workflow
timeouts, runner choices or required gates. Existing checksum-owning callers keep
their checksum checks. The bootstrap actions previously imposed no published
archive checksum check. Temporary download archives are removed after extraction.
