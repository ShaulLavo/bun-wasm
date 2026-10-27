## 0014 CommonJS require.main printing

Class **Port**. The upstream path is `src/bundler/transpiler.rs` at pinned Bun
revision `9510e74152073d850a18758ca41114d8f214ffa6`.

The ESM print path now forwards the AST's existing `exports_kind` to its cold
printer arm and selects the CommonJS module type for a CommonJS AST, matching
the existing EsmAscii arm. Bun lowers `require.main === module` to an
`import.meta.main` node internally. CommonJS printing lowers that node back to
`require.main == module` instead of emitting module-only syntax inside the
CommonJS wrapper. ESM printing is unchanged.

The browser host needs this because it reprints JavaScript containing `await`
to add AsyncLocalStorage hooks. Native Bun 1.4.4 preserves `require.main` in
its public transform and is the behavioral reference. This is a runtime port
correction, not a claim that native Bun's public transform is broken.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0014](#0014-commonjs-requiremain-printing) | Port | Select CommonJS printing for CommonJS ASTs so `require.main` remains valid inside the wrapper. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
