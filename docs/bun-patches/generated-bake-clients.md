### Generated bake clients

`crates/bunwasm-build/generated/bake.client.js` and `crates/bunwasm-build/generated/bake.error.js`. Class **Port**. Upstream `src/codegen/bake-codegen.ts` generates these from `src/runtime/bake/hmr-runtime-client.ts`, `src/runtime/bake/hmr-runtime-error.ts`, and their imported client/runtime modules at the Bun pin.

`scripts/generate-bake.sh` runs that generator and copies the resulting bundles without a local source rewrite. They supply Bun's HMR protocol, React refresh integration, and browser error overlay to the WASI dev server. The script is our adapter. The generated JavaScript is upstream code, and `--check` compares both embedded files with fresh generator output.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-build/generated/bake.client.js`, `crates/bunwasm-build/generated/bake.error.js`](#generated-bake-clients) | Port | Embed Bun's generated browser HMR client and error overlay. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
