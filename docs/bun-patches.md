# Changes to Bun and other upstream source

[Browse patch and adapter records](bun-patches/). Each record owns its classification,
upstream paths and revisions, local changes, and reasons.

[Scope and class definitions](bun-patches/scope.md) distinguish ports, host features,
and upstream bugs. Add or update the relevant record, not this entrypoint.

## Current host-feature overview

| Record | Class | Boundary |
| --- | --- | --- |
| [DNS lookup capability](bun-patches/dns-lookup-capability.md) | Host feature | Native ABI v2/16 `lookup_start`/`lookup_head` over copied-input `getaddrinfo`; shared runtime waiter adapter. The browser Promise provider and raw-slot absence remain unchanged. |

The [migration map](../scripts/migrations/bun-patches-map.json) maps the former
single-page anchors to their records. The deterministic splitter and proof are
in [split-bun-patches.ts](../scripts/migrations/split-bun-patches.ts).
