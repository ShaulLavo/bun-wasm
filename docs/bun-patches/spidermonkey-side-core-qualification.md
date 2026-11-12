# SpiderMonkey side/core qualification adapter

This record covers the original bun-wasm adapter that stages SpiderMonkey native
bytes and qualifies an experimental split side/core pair. Its origins are a
parent-admitted archive and a fresh recipe-built library. Supported guest receipts
and publication contracts remain separate.

| Path | Class | Change |
| --- | --- | --- |
| `spidermonkey/prepare-engine-inputs.ts` | Original adapter | Verify the historical or current parent native-byte admission receipt or the actual fresh `vm-library.json`, and copy exact archive, profile, headers and confdefs into a private root. Fresh origins carry `BUILT_FROM_RECIPE` and the library receipt hash, without admission flags. The verifier distinguishes both schema 3 origins by the explicit `fresh-library` origin and requires the same current performance profile and effective release/DEBUG macros for fresh and current-admitted generations. |
| `spidermonkey/admit-native.ts` | Original adapter | Replay current N1 qualification before staging a fresh generation. Bind its successful receipt, actual library and embedding macros, source, archive, profile and matching headers. This uses a separate current admission status and never claims an old failed attempt as new evidence. |
| `scripts/spidermonkey-side-core-receipt.ts` | Original adapter | Convert the side initializer exports, remove only `.debug_*` custom sections, inspect split imports/exports and exception tags, tag the generic core, and write an experimental pair receipt bound to one source tree and N1 input receipt. Preserve `name`, `dylink.0`, profile/engine/features and unknown metadata, and all executable bytes except the existing initializer/export rewrite. |
| `scripts/build-engine-spidermonkey.sh`, `scripts/build-bun-spidermonkey.sh` | Original adapters | Build the private SpiderMonkey side and compose it with the generic core through the experimental helper. They do not call normal SpiderMonkey guest receipts, the generic initializer helper, or the normal producer. |
| `scripts/spidermonkey-ordinary-ci.ts` | Original adapter | Cache the ordinary recipe's sparse source, objects and verified library by exact native recipe, glue, compiler, pinned cbindgen and actual ordinary sysroot bytes. Reuse PR 599's sparse promisor setup and isolated pip-free Python pattern, with ordinary no-EH archives. Namespace side Cargo objects by the resulting native identity. |
| `scripts/spidermonkey-ordinary-fixtures.ts` | Original adapter | Own the reviewed twelve-case list and call `test.sh` once with explicit core, launcher, shell and env guest paths and interpreter tier. The runtime owner runs it once after the existing Rust-job producers. Source tests have a separate quality owner. |

The admitted staging receipt includes an unchanged copy and digest of the parent admission,
the later qualification, and the original failed attempt and unclaimed compiler
provenance for historical admission. Current-generation admission instead records
successful N1 proof with the exact performance profile and effective macros.
It never changes the original native directory. The legacy archive
basename is only a private symlink to the same admitted bytes.

The experimental initializer converter keeps function and data sections unchanged,
uses global-only import indices, and rejects implicit initialization after conversion.
Ordinary CI also owns the fresh-library staging origin, the exact native cache,
and one interpreter fixture gate in the existing Rust job. Its delivery remains
an experimental split pair. Shared-group producers and supported publication
registries have separate owners.

The pair recipe requires `SPIDERMONKEY_PAIR_DIR`, checks source and native inputs
before and after the build, and limits the side compiler to four jobs. Outputs stay
private. Ordinary CI runs its live interpreter gate before exporting
`ordinary-spidermonkey-program`. Its extraction root directly contains the pair,
experimental receipt, captured inputs and unchanged common-core receipt. Small
native receipts and identity records live in `native-identity/`. Consumers do not
need producer paths, the Mozilla archive, source tree or Cargo objects. Runtime
source changes rebuild the side while the exact native generation stays reusable.
