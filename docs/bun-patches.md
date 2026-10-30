# Changes to Bun and other upstream source

[Browse patch and adapter records](bun-patches/). Each record owns its classification,
upstream paths and revisions, local changes, and reasons.

[Scope and class definitions](bun-patches/scope.md) distinguish ports, host features,
and upstream bugs. Add or update the relevant record, not this entrypoint.

The [migration map](../scripts/migrations/bun-patches-map.json) maps the former
single-page anchors to their records. The deterministic splitter and proof are
in [split-bun-patches.ts](../scripts/migrations/split-bun-patches.ts).

| Adapter | Classification | Record |
| --- | --- | --- |
| Hermes Next NFT require lookup | Original adapter and original test adapter with an upstream reference | [Scope and verification](bun-patches/hermes-nft-require.md) |
