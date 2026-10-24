### Temporal

`third_party/temporal/entry.js`, `package.json`, and `bun.lock` pin `@js-temporal/polyfill` **0.5.1** and **jsbi 4.3.2**. Class **Host feature** for packaging the fallback.

`scripts/vendor-temporal.py` bundles the unmodified packages, minifies them, and wraps the CommonJS output as a factory in `crates/bunwasm-runtime/src/js/temporal.js`. Without the wrapper our engine cannot load the fallback used for Bun's TOML date values. There are no local changes to either dependency's source. The entry, lockfile, and copied licenses record its provenance.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/temporal.js`](#temporal) | Host feature | Package the unmodified Temporal polyfill for engines without Temporal. |

[Parent context](bun-patch-series.md).
