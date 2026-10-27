# Changes to Bun and other upstream source

[Browse patch and adapter records](bun-patches/). Each record owns its classification,
upstream paths and revisions, local changes, and reasons.

[Scope and class definitions](bun-patches/scope.md) distinguish ports, host features,
and upstream bugs. Add or update the relevant record, not this entrypoint.

The [migration map](../scripts/migrations/bun-patches-map.json) maps the former
single-page anchors to their records. The deterministic splitter and proof are
in [split-bun-patches.ts](../scripts/migrations/split-bun-patches.ts).

| Adapter | Class | Record |
| --- | --- | --- |
| HTTP/2 request class and builtin registration | Port / Host feature | [Request compatibility](bun-patches/http2-request-compatibility-class.md) |
