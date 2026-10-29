# Changes to Bun and other upstream source

[Browse patch and adapter records](bun-patches/). Each record owns its classification,
upstream paths and revisions, local changes, and reasons.

[Scope and class definitions](bun-patches/scope.md) distinguish ports, host features,
and upstream bugs. Add or update the relevant record, not this entrypoint.

The [migration map](../scripts/migrations/bun-patches-map.json) maps the former
single-page anchors to their records. The deterministic splitter and proof are
in [split-bun-patches.ts](../scripts/migrations/split-bun-patches.ts).

| Adapter | Class | Upstream |
| --- | --- | --- |
| [Vite 8 official Wasm packages](bun-patches/vite8-wasm-packages.md) | Original installer adapter | Lightning CSS 1.33.0, Rolldown 1.2.15, Oxc 0.156.0 |
