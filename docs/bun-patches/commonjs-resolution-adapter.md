## CommonJS public resolution adapter

Class **Host feature**, **original adapter** in
`crates/bunwasm-runtime/src/js/bootstrap.js`. No upstream implementation is copied.
The adapter preserves the caller's builtin spelling in `require.resolve()` while
keeping `node:`-prefixed identifiers inside the resolver and module cache.
`createRequire()` and `import.meta.require` use the same public adapter.

Native Bun 1.4.4 and Node 26.12.1 both return `process` for
`require.resolve("process")` and `node:process` for the explicitly prefixed input.
Next 15.5.6 passes that first result to Webpack's `ProvidePlugin`. Changing it to
`node:process` bypasses Next's bare `process` fallback and reproduces Webpack
5.98.0's `UnhandledSchemeError`. File and package paths are not changed.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `src/js/bootstrap.js`, public `require.resolve()` result | Host feature | Original public spelling adapter; internal resolution and loading remain canonical. |

[Ledger scope and pinned revisions](scope.md).
