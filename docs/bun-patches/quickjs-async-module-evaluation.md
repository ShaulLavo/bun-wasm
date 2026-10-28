## QuickJS async module evaluation completion

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. QuickJS-ng master still carries the unfixed code.

A module without top-level await that imports one with it waits for that dependency. When the dependency finished, `js_async_module_execution_fulfilled` ran the waiting module and marked it evaluated, but left its `async_evaluation` flag set. The spec's AsyncModuleExecutionFulfilled clears `[[AsyncEvaluation]]` there. A later import graph that reached the module therefore registered itself as one of its async parents and waited for a completion that had already happened. With no jobs or handles left, the process drained and exited with the import still pending.

SvelteKit's second Vite config load hit this: `@sveltejs/kit/vite` reaches `src/core/sync/utils.js`, which awaits `import('svelte/compiler')` at top level. The nested client `vite.build` in Kit's `writeBundle` imports a fresh bundled config, so `vite build` exited with Rollup's unfinished `(vite-plugin-sveltekit-compile) writeBundle` hook.

The fix clears the flag after the waiting module runs, and also on async rejection. Both lines match upstream QuickJS commit [`2fd48bf`](https://github.com/bellard/quickjs/commit/2fd48bf7df44845cd9c0bf5ba44632a4adc09dce) ("fixed module async evaluation logic", 2025-06-28); the rest of that commit only adds debug dumps. It adds no public engine API.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, async module evaluation](#quickjs-async-module-evaluation-completion) | Upstream bug | Clear `async_evaluation` when an async-evaluated module finishes, so later importers don't wait for it again. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
