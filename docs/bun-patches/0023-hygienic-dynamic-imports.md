# Hygienic dynamic import hooks

`0023-wasm-use-an-unshadowable-dynamic-import-hook.patch` is a **Host feature**.
It changes `src/js_printer/lib.rs` at pinned Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`, after the existing patch series.

Runtime file preparation and CommonJS bundling emit a call through a function
literal's `__bunwasmFunctionImport` property instead of a lexical `globalThis`
lookup. A module binding or parameter named `globalThis` therefore cannot
intercept ordinary or attributed imports. Import arguments and their order stay
unchanged. Existing printer source-map accounting includes the replacement.

The original adapter in `crates/bunwasm-runtime/src/js/function.ts` installs that
non-writable, non-configurable helper on JSC as well as the other engines.
JSC still keeps its native function constructors. No VM interface changes.
The Browser store and CommonJS adapters in `web/src/engine-host.js` and
`crates/bunwasm-runtime/src/engine_host.rs` use the same helper for their dynamic
import substitutions. The Browser metadata prologue uses a separate
non-writable function-prototype helper and no lexical global lookup. That helper
looks up the current host dispatch on each call, like the import helper, rather
than capturing a bootstrap's `internal` object. Compiler controls verify the
emitted call, and the normal text-import fixture executes ordinary and text
imports with shadowed names in `.mjs` and `.cjs` files.

[Ledger scope and pinned revisions](scope.md).
