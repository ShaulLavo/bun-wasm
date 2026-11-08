# Angular module syntax

Status: Approved. The module syntax fix is implemented and regression-tested.

Angular's development command fails when the browser engine evaluates `import.meta` as classic-script syntax. The genuine Chrome control reproduces the same defect after a successful install, so the original Firefox-only label was incomplete.

Scope is the module syntax and loader path. QuickJS stack budgets, generic render timeouts, Waffle, versions, and README changes are excluded. Exact implementation file ownership is reported to the Firefox coordinator before source changes.

The actual browser-guest regression failed before the fix and passes afterward. Both real Angular goals cells get beyond the syntax failure under unchanged 90-second phase limits, then fail on a separate `import_ansi_regex.default is not a function` error. Guest source and shell receipt are recorded separately from host source. The coordinator owns independent review and landing.


## Remaining cross-browser import failure

Both real cells install successfully and now fail during development startup with `TypeError: import_ansi_regex.default is not a function`. This is not caused by the metadata fix. A three-file control reproduces the equivalent `import_child.default is not a function` with both baseline browser core `5edf588b109bba7273abf5184a35efcbc335b7c5` and fixed core `b56fef2902d0e02914e99e6fbd78f2f2cf2f747c`.

Run `source env.sh && bun /work/reports/goals/firefox/angular/interop-control.ts` from the author worktree while its guest artifacts remain. The control writes a CommonJS entry requiring an ES module that imports another module's default function. Both cores exit 1. The reproducer and exact output are retained in that report directory. Inspect the host `esm_to_cjs` adapter in `crates/bunwasm-cli/src/main.rs` and the CommonJS export handoff in `crates/bunwasm-runtime/src/js/bootstrap.js` before choosing a fix. No interop fix is included in this bounded PR.

Actual cells use `scripts/goals-matrix/run.ts --browsers=chrome,firefox --engines=browser --frameworks=angular --timeout-ms=90000`. Separate `baseline/` and `after/` reports preserve source identities, successful installs, concrete startup errors, and browser/server cleanup. Canonical goal reports are unchanged.
