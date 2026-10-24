# Playground: measurement history

Working notes moved out of `docs/playground.md`. The public page keeps the current facts and the reproducing command (`bun web/tests/browser-process.ts chromium|firefox|webkit --benchmark`). The dated run below records the machine, commit and bytes.

## Spawn measurements

On 2026-10-17, an M1 MacBook Air ran five
starts per mode, browser and revision, comparing the process model against commit `c7f08312`. Network transfer is excluded. Cold starts compile fresh bytes with a unique custom
section; shared starts reuse a compiled module. First output uses the same 1 ms shared-memory
poll in both revisions. The reused WASM was 12,607,668 bytes, SHA-256
`db607962302070c6584005d6f43d33dee4296f79657912722bbecb3ee733bbf3`.

| Browser | Cold median, candidate / baseline (ms) | Shared-module median, candidate / baseline (ms) |
| --- | ---: | ---: |
| Chromium 156 | 67.320 / 69.570 | 32.630 / 32.555 |
| Firefox 157 | 184.440 / 183.720 | 48.340 / 48.780 |
| WebKit 27.2 | 90.560 / 89.160 | 39.640 / 40.680 |

Startup is roughly unchanged in this bounded comparison; these are not cross-machine results
or a speedup claim. No worker pool is implemented or enabled, so there is no pool timing.
Each browser also passed 15 process checks, including eight orphan-survival cycles that recover
all child slots and supervisor records, with zero active process workers after cleanup.
