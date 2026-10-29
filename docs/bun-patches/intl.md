### Intl

`third_party/intl/package.json` and `bun.lock` pin the FormatJS ponyfills listed in `docs/intl.md`. Class **Host feature** for packaging the fallback.

`scripts/vendor-intl.ts` bundles the unmodified packages and their locale data, minifies them, and wraps the CommonJS output as a factory in `crates/bunwasm-runtime/src/js/intl.js`. The TypeScript entry point and namespace adapter are original bun-wasm code. They select the locale packs and let FormatJS's generated locale modules register through the lazy global. No dependency source is edited. Copied licenses record the bundled package closure.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/intl.js`](#intl) | Host feature | Package unmodified FormatJS implementations and data for engines without full Intl. |
| [`third_party/intl/entry.ts` and `namespace.ts`](#intl) | Host feature | Select locale data and adapt FormatJS registration to the lazy runtime global. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
