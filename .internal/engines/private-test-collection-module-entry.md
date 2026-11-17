# Private ownership at module entry

Status: Approved for parent sizing and coordination. Native design and implementation are unstarted. No native, host, provider or public ALS change is part of PR 872.

## Split and checkpoints

The parent chose to split deferred collection from PR 872. The complete collector implementation is preserved at `bf7d0969cd553c20f428c8694a888f3d2d5f3ad1` on the local-only branch `private/pr872-deferred-collector-bf7d0969`. Commit `a84dcac8f` reverts it without rewriting history. The lifecycle basis is the parent's `c60536a5b64f0c6d95cce96f5835e9c2bc635337`, followed by a normal main merge that includes PR 866.

PR 872 keeps missing-callback validation for test.failing, the jest timeout alias, retry/repeat attempts and final outcome reporting, onTestFinished, test-local cleanup, and live/reentrant cleanup queues. It restores describe registration to the original base behavior. Callable describe and new label validation are deferred; neither the synchronous nor asynchronous callable form is advertised as a new supported feature. The two unchanged upstream callable cases remain failures, not filtered tests or recovered cells. The old two-argument async describe completion behavior is also not repaired by this lifecycle unit.

## Demonstrated gap

The collector requires original private frame identity before any registration. Source controls and locally built QuickJS, Browser-on-Node and SpiderMonkey guests satisfy the bounded ordinary-path controls. JSC rejects the first root registration because its imported module does not inherit that frame. This is not a disabled ALS getter/setter: direct calls and Promise awaits preserve the store. USE_BUN_JSC_ADDITIONS was enabled in the owned JSC build.

The independent carrier probe imports no bun:test module and does not initialize the collector:

```ts
// store.ts
import { AsyncLocalStorage } from "node:async_hooks";
export const store = new AsyncLocalStorage();

// dependency.ts
import { store } from "./store.ts";
console.log("dependency", store.getStore() ?? "missing");
await Promise.resolve();
console.log("dependency-await", store.getStore() ?? "missing");

// root.ts
import { store } from "./store.ts";
await store.run("owner", async () => {
  console.log("direct", store.getStore() ?? "missing");
  await Promise.resolve();
  console.log("promise", store.getStore() ?? "missing");
  await import("./dependency.ts");
  console.log("after-import", store.getStore() ?? "missing");
});
console.log("outside", store.getStore() ?? "missing");
```

QuickJS, Browser-on-Node and SpiderMonkey print owner for all five inside observations, then missing outside. JSC prints owner for direct, promise and after-import, but missing for dependency and dependency-await. Native Bun 1.4.4, revision 38afee6c8, prints the JSC sequence too. Therefore changing public ALS import behavior to make collection pass would not establish native collection parity. Native Bun's test collection has a separate ownership mechanism.

## Exact source and executable evidence

- `crates/bunwasm-engine-jsc/src/vm.rs`, Engine::import_module, calls bunjsc_import. At the recorded source this starts at line 713.
- `crates/bunwasm-jsc/cpp/helpers.cpp:384`, bunjsc_import, calls requestImport and returns the namespace Promise.
- `helpers.cpp:179`, requestImport, calls JSModuleLoader::requestImportModule. Its dynamic-import hook begins at line 190. The method table is installed in bunjsc_create_context around line 350.
- `helpers.cpp:729` and `:740` expose get/set async context using m_asyncContextData. The probe proves those work through direct Promise continuations. No edit was made to them.
- `crates/bunwasm-runtime/src/js/bootstrap.js` exposes internal.importModule through native.importModule and implements runInContext with synchronous save/restore. The collector checkpoint enters its root frame around imports, but that does not give the later JSC module body an original frame.

The preserved implementation evidence is `/work/reports/wave-20261116/engines/runner-lifecycle/collector-implementation/RESULT.md`. Its `carrier-probe.py` contains the exact source strings and recreates private scratch. `carrier-jsc.command.json` records the actual launcher argv and owned guest paths. `carrier-jsc.stdout`, `carrier-native.stdout`, and the other three carrier streams retain the result. `fixtures-final-jsc/test-async-collection.stderr` records the first missing-frame registration. The four after-final-jsc upstream records are import-blocked, not additional named assertion failures or parity passes.

After building fresh source-owned guests with the maintained scripts, the JSC probe invocation has this form:

```sh
source env.sh
"$BUN_WASM_LAUNCHER" --wasm "$JSC_CORE" --engine "jsc=$JSC_CORE" \
  --dir "$probe_directory::/" --env PWD=/ --env NO_COLOR=1 run /root.ts
```

The report's command JSON supplies the exact recorded values. Their binaries and scratch directories were deleted after consumers stopped; they are not held for this follow-up. Rebuild locally for new work. No CI artifact or other lane's binary is needed.

## Candidate private ownership requirements

These are requirements for the separate design, not a prescribed native patch:

1. Bind the actual requesting collection frame to module evaluation entry, including root/preload imports, TLA, dependencies and awaited dynamic imports inside a describe. Do not infer ownership from whichever global file or scope is active later.
2. Keep private registration provenance separate from public ALS values. Preserve the measured public ALS import semantics unless a separate product decision explicitly changes them.
3. Preserve first-evaluation ownership of cached declaration modules. A later import must not replay or transfer declarations, including declarations excluded because their first owner failed collection.
4. File and scope identity must survive callback completion and closure. Missing, closed and non-admitted original frames reject before tree, only-selection or cleanup mutation. Revoke a callback before collecting its children. Never reopen a closed file.
5. Keep the checkpoint's serial depth-first collection, undefined describe return, genuine-Promise intrinsic observation, failed-subtree exclusion and sticky only behavior. Do not reuse test invocation retries, matcher pending state or synchronous timer draining as a collection mechanism.
6. Whole-frame ALS.bind, ALS.snapshot and AsyncResource restoration can install another currently admitted frame. The checkpoint's equality guard cannot detect that case. Preserve its unsupported classification rather than claiming universal provenance recovery. The existing counter-controls are retained in the implementation report and independent design review.
7. Browser synthetic hooks are not universally qualified by Node continuation controls. The optional hook/record-mode owned fixture failed at cached-module TLA with a missing frame; the raw failing result remains. Unhooked/dynamic sources and documented rejection/generator/await-using gaps need explicit qualification, not fallback registration.
8. Preserve parent lifecycle cleanup and PR 866 assertion/settlement/timer behavior. No invoke, classify, snapshot or unrelated carrier rewrite is implied by this plan.

## Parent sizing and next step

The parent coordinates a bounded source diagnosis of private module-entry provenance, then chooses the smallest mechanism and its caller/type boundary before implementation. Size that work in agent hours from the traced mechanism and measured build/test costs; the current evidence does not justify inventing a quick native patch estimate. Native design and implementation remain unstarted until that step is assigned.

Requalify the review's ordinary source/native controls and real guest entry paths after a design is approved. Keep unsupported cases explicit. There is no merge hold on another PR, no artifact retention request and no authorization here for a public ALS or host/provider project.
