# Explicit CommonJS exports from ES modules

The shared loader in `crates/bunwasm-runtime/src/js/bootstrap.js` is an original
adapter. No upstream implementation is copied. It follows Bun's observable
`require(esm)` contract at pinned revision
`9510e74152073d850a18758ca41114d8f214ffa6`, implemented upstream in
`src/js/builtins/CommonJS.ts`.

An ES module can export a value named `module.exports` to choose the result of
CommonJS `require`. Select that value after evaluation and store it in the
CommonJS cache. Null and undefined retain the namespace, matching native Bun
1.4.4. False and zero are valid overrides. ES imports retain the original
namespace and default export. Genuine CommonJS exports are unchanged.

The installed `yargs@18.0.0/index.mjs` exports its factory as both `default` and
`module.exports`. Returning its namespace made Angular's CommonJS default-import
helper wrap an object instead of the factory. The dependency-free fixture
`tests/fixtures/require-esm-commonjs-export` checks the factory call, distinct ES
default, live exports, cache identity, nullish and falsy values, ordinary
namespaces and CommonJS controls.

| Source | Class | Change |
| --- | --- | --- |
| `src/js/bootstrap.js`, ES-module require result | Host feature | Original adapter selecting the explicit CommonJS export. |
