# CommonJS loader stack cost

Class **Host feature**, **original adapter** in
`crates/bunwasm-runtime/src/js/bootstrap.js`. No upstream implementation is copied,
and no upstream file changes.

## Problem

Safari gives QuickJS a 32 KiB stack budget ([Stack overflow in wasm](../stack-limits.md)).
A nested `require` held six loader functions between one module body and the next:
the module's own `require`, `Module.prototype.require`, `requireFrom`, `loadModule`,
`evaluateModule` and `callModuleWrapper`. Each JavaScript frame costs QuickJS about
320 bytes of that budget, so one nested level cost 2,858 bytes and only eight trivial
levels fit. `prompts` 2.4.2, which Astro loads, could not load at all.

## Change

`requireFunction` builds both `Module.prototype.require` and each module's own
`require` from one function body. That function resolves the request, checks the
cache, compiles the module and then runs the module body directly, so one loader
frame stays under each nested level instead of six. Steps that finish before the
body runs (`resolveFrom`, `moduleWrapper`, `wrapperArguments`) remain ordinary
calls. `evaluateModule` keeps the same sequence for the two entry points outside
`require`: the main module and ES module imports.

Behavior the adapter preserves:

- A replaced `Module.prototype.require`, or a `require` set on one module, is still
  called. A module's own `require` compares its module's method with the original
  and calls the replacement when they differ. An accessor method is read once,
  and that exact returned callable receives the module as its receiver.
- A module enters the cache before its body runs, so cycles see partial exports.
  A body that throws leaves the cache.
- The wrapper receives `module.exports` as `this` and the same five arguments, or
  six for a transpiled ES module with its `import.meta` object.
- JSON, HTML, text and required ES module formats take the same routes as before.

The wrapper is entered through `Reflect.apply`, captured before application code.
Module loading does not consult mutable `call` or `apply` properties on a wrapper.
The initial one-frame measurement used `Function.prototype.apply`; its native
call accounted for about 510 of 1,217 bytes per level. Those measurements precede
the captured-intrinsic and single-accessor-read corrections. The discovered
16-level fixture remains blocking, and current-head capacity must be remeasured
on its actual produced guest. Removing the native invocation itself needs a
different wrapper source shape and is outside this change.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `src/js/bootstrap.js`, `requireFunction`, `moduleWrapper`, `wrapperArguments`, `evaluateModule` | Host feature | Original adapter: one loader frame per nested `require`. |
| `tests/fixtures/require-chain-stack` | Host feature | Original regression: a 16-module chain in a child with `BUN_WASM_STACK_KIB=32`, a caught overflow inside a nested module, and a clean cache afterwards. |
| `tests/stack-depth.js` `require` mode, `scripts/measure-stack.py` `--leaf-root` and `--leaf` | Host feature | Original measurement control for nested `require` capacity, alone or above a real package. |
| `scripts/measure-require-depth.ts` | Host feature | Original Node preload that prints the CommonJS chain above a named module. |

Measurements and their limits are in [Stack overflow in wasm](../stack-limits.md#nested-require).

[Ledger scope and pinned revisions](scope.md).
