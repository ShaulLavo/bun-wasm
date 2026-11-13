# Standard Browser CI delivery

These are original repository adapters. No upstream source is copied or adapted,
so they have no upstream source path or revision. The original receipts retain
the imported Bun revision and native identities.

| Source | Class | Change and reason |
| --- | --- | --- |
| `scripts/build-bun-browser.sh` | Original adapter | Keep Cargo locked when the maintained standard Browser recipe replaces CI's former host-engine compile. The feature tuple and optimizer are unchanged. |
| `scripts/ci-browser-program.ts` | Original adapter | Verify exact Browser and tools build labels, raw bytes, companion contracts and composing source, then copy original receipts with the guests. |
| `.github/workflows/ci.yml` | Original adapter | Build the standard Browser recipe once in the existing target. Reuse it for native, Web, source-cache and transfer regressions. Export Browser and tools after their existing gates. Migrate CI artifact names and consumers together. |
| `scripts/ci-changes.ts` | Original adapter | Select the existing Rust producer for the maintained Browser recipe and export helper. |

The Browser guest includes `engine-host,bun-transpiler,bun-build` and its normal
optimizer. No additional guest build, CI job or blocking gate is introduced.
Native cache restore and save keys include the recipe. `browser-program` contains
the raw Browser and tools guests, both unchanged build receipts, source head and
tree, and their existing artifact identity fields. The source-cache browser
regression verifies the delivery before using it. The transfer test consumes
the same guest. Their scenarios, deadlines and blocking owners remain intact.

C1 keeps its separate unoptimized `source-cache-browser` recipe. Its receipt
cannot satisfy the unchanged standard Browser site preflight. No compatibility
alias for the retired CI source-cache artifact remains.
