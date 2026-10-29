### Intl

`third_party/intl/package.json` and `bun.lock` pin the FormatJS ponyfills listed in `docs/intl.md`. `Cargo.lock` pins ICU4X **2.4.0** for collation. Class **Host feature** for packaging the fallback.

`scripts/vendor-intl.ts` bundles the unmodified packages and their locale data, minifies them, and wraps the CommonJS output as a factory in `crates/bunwasm-runtime/src/js/intl.js`. The TypeScript entry point and namespace adapter are original bun-wasm code. They select the locale packs and let FormatJS's generated locale modules register through the lazy global. No dependency source is edited. Copied licenses record the bundled package closure.

The generator installs private copies with a temporary package cache. The source gate classifies only its exact generated output path. The original Rust adapter returns an explicit null for an unsupported locale, matching the TypeScript resolver contract across every engine's plain-data bridge; the generic optional-value conversion would return undefined instead.

For `ignorePunctuation`, the adapter selects ICU4X shifted handling while keeping the requested sensitivity. Raising variant sensitivity to quaternary would compare the shifted punctuation again.

The Rust locale resolver preserves parsed `kn` and `kf` preferences and checks `co` against the baked ICU4X collation metadata before retaining it. The TypeScript adapter builds the resolved locale from these supported keys, removing a key when an explicit option changes its value. Matching options retain the requested key; options alone do not add locale extensions. Native-backed factory tests exercise both adapters together.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/intl.js`](#intl) | Host feature | Package unmodified FormatJS implementations and data for engines without full Intl. |
| [`third_party/intl/entry.ts` and `namespace.ts`](#intl) | Host feature | Select locale data and adapt FormatJS registration to the lazy runtime global. |
| [`third_party/intl/collator.ts` and `crates/bunwasm-runtime/src/intl.rs`](#intl) | Host feature | Adapt the ECMA-402 collator contract to unmodified ICU4X. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
