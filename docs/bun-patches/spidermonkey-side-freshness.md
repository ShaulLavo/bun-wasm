# SpiderMonkey side freshness and site adapter

These are original bun-wasm adapters, with no copied upstream source or revision.
The existing [side/core adapter](spidermonkey-side-core-qualification.md) retains
its native admission and initializer conversion behavior.

| Path | Class | Change and reason |
| --- | --- | --- |
| `scripts/spidermonkey-side-inputs.ts` | Original adapter | Hash sorted source paths and content across both SpiderMonkey crates, shared side and nested runtime sources, Cargo inputs, and ordinary native and side recipes. Exclude Git provenance and unrelated documentation or site changes. |
| `scripts/spidermonkey-side-core-receipt.ts` | Original adapter | Carry `sideSourceSha256` through input capture, parsing, pair writing and verification while retaining original source head/tree and native identities. |
| `scripts/site-guest-preflight.ts`, `site/build.ts` | Original adapters | Resolve optional ordinary SpiderMonkey delivery before builds, verify its delivered pair and current side sources, and compare core bytes with the qualified QuickJS core after removing only engine tags. Consumers need no native archive. |
