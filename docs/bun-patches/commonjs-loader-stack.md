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
`require` from one function body. A module's own `require` calls `owner.require(spec)`.
The prototype method resolves the request, checks the cache, compiles the module
and runs its body directly. Steps that finish before the
body runs (`resolveFrom`, `moduleWrapper`, `wrapperArguments`) remain ordinary
calls. `evaluateModule` keeps the same sequence for the two entry points outside
`require`: the main module and ES module imports.

Behavior the adapter preserves:

- A replaced `Module.prototype.require`, or a `require` set on one module, is still
  called. A module's own `require` looks up its module's current method on each call.
  An accessor method is read once,
  and that exact returned callable receives the module as its receiver.
- A module enters the cache before its body runs, so cycles see partial exports.
  A body that throws leaves the cache.
- The wrapper receives `module.exports` as `this` and the same five arguments, or
  six for a transpiled ES module with its `import.meta` object.
- JSON, HTML, text and required ES module formats take the same routes as before.
- Hot-mode file requires are rejected after builtin resolution and before cache reuse.
  The guard returns before the module body runs, so it adds no retained loader frame.

The wrapper is entered through `Reflect.apply`, captured before application code.
Module loading does not consult mutable `call` or `apply` properties on a wrapper.
A require hook uses ordinary method dispatch. This adds an ordinary bytecode frame
on the default path, which QuickJS stores outside the native stack after PR 597,
and removes a native `Reflect.apply` entry on the hooked path. A retained-pair
diagnostic got Next 15.5.6 past webpack compilation at 32 KiB by changing only
this dispatch. The normal source-built guest still refuses at 32 KiB and loads
the initializer at 36 KiB; Next's own native `call` reentry remains. This loader
improvement does not close the remaining mobile Next failure.
The 24-module hooked chain regression also loads, catches an overflow in a longer
chain, clears failed cache entries and loads another hooked chain.
The initial one-frame measurement used `Function.prototype.apply`; its native
call accounted for about 510 of 1,217 bytes per level. Those measurements precede
the captured-intrinsic and single-accessor-read corrections. The discovered
16-level fixture remains blocking, and current-head capacity must be remeasured
on its actual produced guest. Removing the native invocation itself needs a
different wrapper source shape and is outside this change.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `src/js/bootstrap.js`, `requireFunction`, `moduleWrapper`, `wrapperArguments`, `evaluateModule` | Host feature | Original adapter: direct module-method dispatch and one body-running loader frame per nested `require`. |
| `tests/fixtures/require-chain-stack` | Host feature | Original regression: 16 ordinary modules and 24 hooked modules in a child with `BUN_WASM_STACK_KIB=32`, caught overflows and clean caches afterwards. |
| `tests/stack-depth.js` `require` mode, `scripts/measure-stack.py` `--leaf-root` and `--leaf` | Host feature | Original measurement control for nested `require` capacity, alone or above a real package. |
| `scripts/measure-require-depth.ts` | Host feature | Original Node preload that prints the CommonJS chain above a named module. |

Measurements and their limits are in [Stack overflow in wasm](../stack-limits.md#nested-require).

[Ledger scope and pinned revisions](scope.md).
