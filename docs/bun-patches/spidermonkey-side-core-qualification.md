# SpiderMonkey side/core qualification adapter

This record covers the original bun-wasm adapter that stages parent-admitted
SpiderMonkey N1 bytes and qualifies an experimental split side/core pair. It does
not change the normal guest producer, receipt, initializer, default engine menu or
publication contracts.

| Path | Class | Change |
| --- | --- | --- |
| `spidermonkey/prepare-engine-inputs.ts` | Original adapter | Verify the parent native-byte admission receipt, copy the exact archive, profile, headers and confdefs into a private N2 root, and emit a receipt that preserves admitted provenance without a G1/G2 label. |
| `spidermonkey/admit-native.ts` | Original adapter | Replay current N1 qualification before staging a fresh generation. Bind its successful receipt, actual library and embedding macros, source, archive, profile and matching headers. This uses a separate current admission status and never claims an old failed attempt as new evidence. |
| `scripts/spidermonkey-side-core-receipt.ts` | Original adapter | Convert the side initializer exports, remove only `.debug_*` custom sections, inspect split imports/exports and exception tags, tag the generic core, and write an experimental pair receipt bound to one source tree and N1 input receipt. Preserve `name`, `dylink.0`, profile/engine/features and unknown metadata, and all executable bytes except the existing initializer/export rewrite. |
| `scripts/build-engine-spidermonkey.sh`, `scripts/build-bun-spidermonkey.sh` | Original adapters | Build the private SpiderMonkey side and compose it with the generic core through the experimental helper. They do not call normal SpiderMonkey guest receipts, the generic initializer helper, or the normal producer. |

The staging receipt includes an unchanged copy and digest of the parent admission,
the later qualification, and the original failed attempt and unclaimed compiler
provenance for historical admission. Current-generation admission instead records
successful N1 proof with the exact performance profile and effective macros.
It never changes the original native directory. The legacy archive
basename is only a private symlink to the same admitted bytes.

The experimental initializer converter keeps function and data sections unchanged,
uses global-only import indices, and rejects implicit initialization after conversion.
The pair recipe requires `SPIDERMONKEY_PAIR_DIR`, checks source and native inputs
before and after the build, and limits the side compiler to four jobs. Outputs stay
private and require separate parent acceptance before any native execution.
