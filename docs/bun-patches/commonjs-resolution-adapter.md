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

## Mutable CommonJS resolution hooks

Next 16.4.3 installs its Webpack aliases in
`packages/next/src/server/require-hook.ts`, published as
`next/dist/server/require-hook.js`. Its `addHookAliases()` wraps
`Module._resolveFilename`; the public `require()` and `require.resolve()` calls
must use that mutable resolver for those aliases to take effect.

The original adapter in `src/js/bootstrap.js` passes the calling `Module` to the
public resolver. `createRequire()` and `import.meta.require` have a private
synthetic parent with the same filename and module search paths. The existing
native resolver remains the default, and module loading still uses the shared
CommonJS cache. There are no Next-specific aliases in the runtime.

| Patch or source | Class | Change |
| --- | --- | --- |
| `src/js/bootstrap.js`, mutable `Module._resolveFilename` dispatch | Host feature | Original adapter for the caller's resolver hook and parent module. |
| `scripts/fixtures/next-webpack-resolve-hook/require-hook.txt` | Unmodified upstream fixture | Exact Next 16.4.3 Webpack hook, SHA-256 `e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8`. |
| `scripts/next-webpack-resolve-probe.ts`, `next-webpack-resolve.test.ts` | Host feature | Original controls for alias resolution, parent identity, options, errors, and cache identity. |

The fixture keeps the published source unchanged. Next's MIT license is retained
in `scripts/fixtures/module-compile/next-license.txt`. The control runs the exact
hook with a local JSON module instead of compiling an application. Native Node
and the production bootstrap with the real Host evaluator execute the same
request. This control does not establish a Next application pass or explain the
separate generated Pages `HtmlContext` invariant.
