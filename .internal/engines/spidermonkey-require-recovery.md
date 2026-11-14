# Synchronous require recovery on SpiderMonkey

Status: Unit 3 and Unit 4 of the approved design, implemented. Design and reviews live in
`/work/reports/goals/stack-exhaustion-20261113/spidermonkey-design/`.

## What it does

When an ES module `require()` fails because the engine refused to enter a module body at the
stack limit, the adapter retires the failed records, so a later shallower require compiles fresh
records and succeeds, as in native Bun. Records that succeeded keep their identity and never run
again.

The adapter (`crates/bunwasm-spidermonkey/cpp/engine.cpp`) keeps one `ModuleEntry` per mapped
module: a generation, static import edges in both directions and sticky holder marks
(`importAcquired`, `untrackedImporter`). After `ModuleLink`, `require_loaded` snapshots the
unevaluated part of the graph. If `ModuleEvaluate` rejects synchronously, `rollback` retires the
failed candidates and their unevaluated importers only when every failed candidate is
refusal-only (`GetModuleEvaluationInfo`: failed, body never entered, engine over-recursion
error) and nothing else holds them. Validation finishes before any mutation; the commit
allocates nothing. Retired entries are freed once no snapshot is active.

Everything else stays cached, as `import()` and native Bun cache it: body failures, failures
inherited from an already failed or pending record, graphs an import acquired, and evaluations
still pending when `ModuleEvaluate` returns.

## Decisions taken during implementation

- Native Bun is the oracle for ordinary fixtures. Native recovers after one require at the
  deepest catch for every measured graph shape, which `require-esm-limit-recovery` covers.
  When the require is retried at every unwind level, native Bun caches the RangeError, while
  SpiderMonkey recovers. That departure is accepted (coordinator, 2026-11-14) and is covered
  only by the adapter controls, which expect recovery with each body run once. Evidence:
  `spidermonkey-design/UNIT3-NATIVE-SCOPE.md`.
- A narrowing that limited rollback to requires that compiled the root themselves was tried and
  dropped; the approved rule stands.
- Termination inside a module body leaves the record failed with `undefined` and
  `ModuleEvaluate` returns a rejected promise rather than `false`. `require_loaded` now returns
  `false` without an exception when terminating, so the bridge stays pending (design S14).

## Proof

- `scripts/spidermonkey-engine-semantics.sh` runs the control driver on `interp` and `pbl`. Mode
  `recovery` sweeps S1-S13 of design 8.2.4 through real native-stack refusals, plus the
  JavaScript-depth sweep and the single and every-level schedules for the five fixture shapes,
  S6d-poisoned, S10 and fault rows F13-F15. `recovery-terminate` is S14; `recovery-map-trap` is
  the F16 death test.
- Where a schedule's target is unreachable with the whole drain deep, only the require's own job
  runs deep (`bsm_control_run_one_job`): the natural import orders S6a and S6c, S7, and S10b.
  The fully deep form still runs for S6a and S6c and reaches the Q4 signatures.
- The ordinary SpiderMonkey list runs on both tiers. Under PBL, `stack-overflow` fails with the
  rollback disabled and passes with it; `require-esm-limit-recovery` passes either way, so it is
  a smoke test and the sweeps carry the proof.
