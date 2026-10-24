## App compatibility fixtures

`scripts/app-matrix/apps.mjs` contains original minimal projects that use published framework APIs. The dependency versions in that file identify the npm upstream revisions. No template source or upstream implementation is copied or adapted. The runner, registry recorder, network namespace wrapper, shared assertions/classifier, and browser driver are original bun-wasm host adapters. The namespace wrapper uses Linux user/network namespaces without changing any upstream source. Retained diagnostic fixtures under `scripts/app-matrix/review-evidence/` are unmodified logs from the pinned packages, including Next 15.5.6, Prisma 6.17.1, Vite 7.1.12 and Rollup 4.64.7; they are regression inputs, not adapted implementations.

`classify.ts` is the original classifier, converted from `classify.mjs` at bun-wasm
revision `9a39a9ad5d5ca191e2020f68ea6fbff4af9837b9`. Class **Host feature**, an
**original adapter**, not a copied upstream implementation. Erased types describe
engine/status/category values and readonly rows without changing diagnostics,
stage boundaries, row identity or classification rules. Its callers and the runner's
source-hash inventory use the renamed file.

The browser driver calls the existing playground test helpers. Recorded dependency tarballs remain unmodified in the external cache, verified by SHA-256; registry metadata is rewritten only in loopback responses to point tarballs at that mirror.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/app-matrix/`](#app-compatibility-fixtures) | Host feature | Original app fixtures, registry recorder and typed classifier, with no copied framework implementation. |

[Ledger scope and pinned revisions](scope.md).
