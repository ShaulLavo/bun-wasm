# Real Bun on our engines

Status: Approved (owner, 2026-10-15)

## Goal

Run as much of Bun's own code as possible, on all three engines (QuickJS, the browser's engine,
JavaScriptCore in wasm). Bun Lite and "full Bun" are one runtime: the more of Bun's code we can
run engine-independently, the fewer polyfills we keep. JSC additionally gets Bun's C++ bindings
where they help.

## Tracks

1. **Bun's JavaScript builtins.** `vendor/bun/src/js/` (node:*, parts of Bun.*, internal modules)
   is Bun's own TypeScript. Generate it with Bun's codegen (`docs/real-runtime-spike.md`), give it
   the `$`-intrinsics and native hooks it calls, implemented once over our `Engine` trait, and
   replace our hand-written modules with Bun's, module by module, measured on Bun's test suite.
2. **Bun's Rust runtime over our engines.** Bun's Rust runtime talks to JavaScript through
   `bun_jsc`. Add a backend for it over our `Engine` trait so Bun's real Rust implementations
   (fs, Bun.file, HTTP parsing, …) run on every engine. Start with one module end to end.
3. **JSC-only native layer.** On the JSC engine, Bun's C++ bindings (spike: first milestone is
   Bun's global object running console.log). Lower priority than 1 and 2.
4. **Compatibility campaign.** Keep fixing until every remaining failure in Bun's test suite is a
   documented platform limitation (or an explicitly "not worth it" item):
   - an app-compatibility matrix (real frameworks and servers, client and server in one tab) is
     the main scoreboard;
   - Bun's own test suite is the coverage gauge (`docs/bun-test-suite/`).

## Rules

- Prefer Bun's code over ours. A polyfill we keep needs a reason (no engine-independent Bun
  equivalent exists yet).
- No suite or fixture regressions on any engine; every module switch is measured before/after.
- Engine-specific behaviour stays behind the `Engine` trait.

## End condition

Every failing file in Bun's suite is categorised as a platform limitation or "not worth it",
with its reason, and the app matrix lists only failures with the same causes.
