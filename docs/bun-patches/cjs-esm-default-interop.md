## CommonJS ESM default interop

`crates/bunwasm-runtime/src/js/bootstrap.js` is **Host feature**, an **original adapter**. It maps CommonJS modules loaded by bun-wasm's JavaScript module loader into the namespace and default values used by ESM imports.

Flagged CommonJS output from the exact cached `@typescript-eslint/parser@8.46.1` package (`dist/index.js`, SHA256 `7a530eb9fb07f8245e84b861f9ec4b1071c2a185eb3fd1cf27ac90d715a6c335`) sets `__esModule` and exports named parser functions without an own `default` property. The previous adapter returned `exports.default` unconditionally for every flagged module, so an ESM default import became `undefined`. Return the namespace object when a flagged CommonJS module has no own `default`; preserve an explicit own `default` export for transpiled modules that provide one.

The regression fixture is `tests/fixtures/cjs-interop`, which now marks its named-only CommonJS library as `__esModule` and exercises both default and named ESM imports. The original product reproduction used ESLint `9.38.0` with the exact cached parser, TypeScript `5.9.3`, and jiti `2.6.1`; the guest artifact was produced from Bun source `af6cced2ce5fa2212458b2b2e69784c7108a37fc` and native Bun `1.4.4 (9efe7eee8)`.

### Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [CommonJS ESM default interop](#commonjs-esm-default-interop) | Host feature | Preserve flagged CommonJS namespace defaults while honoring explicit default exports. |

[Parent context](port-bugs-fixed-in-bun-wasms-own-code.md).

[Ledger scope and pinned revisions](scope.md).
