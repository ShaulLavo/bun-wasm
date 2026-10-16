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

## Next browser follow-up, 2026-10-16

Track 4 continues with Web Crypto after the semantic import rewrite. Next 15.5.6 build,
with PR 9's runtime fixes included, now reaches the unsupported `crypto.subtle.generateKey`
stub in `crates/bunwasm-runtime/src/js/web.js:1277`. Dev still has no useful diagnostic;
start is blocked by build. See [the exact command and retained evidence](../docs/app-matrix/README.md#browser-import-parsing-follow-up).
The crypto algorithm and any later required operations still need a bounded reproduction.

## TypeScript follow-up

Status: Approved. Execute after runtime PRs #12, #13, #14, #16, #18, #19 and #20 merge.

Convert the remaining runtime JavaScript to TypeScript in small module groups. Prefer replacing
our implementations with Bun's own builtin modules where available. Extend `src/js/runtime.d.ts`
with each native or engine contract used, keep strict checking enabled, and compare all three
engines before and after each group. Regenerate copied/generated files from their generators
rather than changing their output by hand. Reconcile this list with the merged tree first.

Remaining files at this change:

- `crates/bunwasm-runtime/src/js/array_buffer_sink.js`
- `crates/bunwasm-runtime/src/js/assert.js`
- `crates/bunwasm-runtime/src/js/bootstrap.js`
- `crates/bunwasm-runtime/src/js/buffer.js`
- `crates/bunwasm-runtime/src/js/builtins.js`
- `crates/bunwasm-runtime/src/js/bun.js`
- `crates/bunwasm-runtime/src/js/bun_builtins.js`
- `crates/bunwasm-runtime/src/js/bun_console_constructor.js`
- `crates/bunwasm-runtime/src/js/bun_sqlite.js`
- `crates/bunwasm-runtime/src/js/bun_test.js`
- `crates/bunwasm-runtime/src/js/console.js`
- `crates/bunwasm-runtime/src/js/console_constructor.js`
- `crates/bunwasm-runtime/src/js/cookie.js`
- `crates/bunwasm-runtime/src/js/events.js`
- `crates/bunwasm-runtime/src/js/formats.js`
- `crates/bunwasm-runtime/src/js/function.js`
- `crates/bunwasm-runtime/src/js/html_server.js`
- `crates/bunwasm-runtime/src/js/inspect.js`
- `crates/bunwasm-runtime/src/js/intl.js`
- `crates/bunwasm-runtime/src/js/jsonl.js`
- `crates/bunwasm-runtime/src/js/net.js`
- `crates/bunwasm-runtime/src/js/node_fs.js`
- `crates/bunwasm-runtime/src/js/node_url.js`
- `crates/bunwasm-runtime/src/js/path.js`
- `crates/bunwasm-runtime/src/js/process.js`
- `crates/bunwasm-runtime/src/js/spawn.js`
- `crates/bunwasm-runtime/src/js/stack_trace.js`
- `crates/bunwasm-runtime/src/js/string_decoder.js`
- `crates/bunwasm-runtime/src/js/structured_clone.js`
- `crates/bunwasm-runtime/src/js/temporal.js`
- `crates/bunwasm-runtime/src/js/util.js`
- `crates/bunwasm-runtime/src/js/web.js`
- `crates/bunwasm-runtime/src/js/webassembly.js`
- `crates/bunwasm-runtime/src/js/websocket.js`
