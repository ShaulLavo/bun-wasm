## Waffle program release fixture

`scripts/fixtures/program-release-v0.0.15.trimmed.json` is copied data from the published
Waffle `programs-v0.0.15` release asset `program-release.json`
(SHA-256 `ce29ce655d6de6658d859d3d3fcfcf0d3bc383a2824c462ad0daddec8707a270`, packed at Waffle
`3050f69d810fe7c851e487135517698b5dfd93e5` and rebound by tools at
`acd64c19a6381c27edd602316e66d81df78abf25`).

Local changes: the fixture keeps the manifest's top-level release identity, runtime and `rebind`
blocks and only the `waffle-base` package entry. It drops the other packages and the
`installCheck` receipt, which the dependency record updater does not read.

Reason: `scripts/update-waffle-records.test.ts` runs the real
`.github/scripts/update-waffle-records.sh` offline against the shape Waffle publishes, so the
record keeps the release schema and tool commit when the updater regenerates it.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/fixtures/program-release-v0.0.15.trimmed.json`](#waffle-program-release-fixture) | Host feature | Trimmed copy of a published Waffle release manifest, used as a test input. |
| `scripts/update-waffle-records.test.ts` | Host feature | Original test of the dependency record updater. |
