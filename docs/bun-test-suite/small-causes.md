# Small API compatibility results

Status: Approved.

The initial implementation measurements below precede the PR review corrections.
The fixed selection contains 65 upstream files assigned to ten first-blocker
causes in PR #40. The control and task artifacts were built independently on
main `b7cf06cde1fbf977b748d97d86ba102262d3f03f`, after the process merge.
Suite revision, dependencies, network isolation and deadlines match between
before and after reports. The runner cwd changes from `test/` to the source
root as part of this task; this is a setup correction, not a runtime path rewrite.

| Engine | Fully passing files before/after | Observed passes before/after | Timeouts before/after |
| --- | --- | --- | --- |
| QuickJS | 0 / 34 | 791 / 997 | 1 / 1 |
| JSC | 0 / 34 | 738 / 944 | 1 / 1 |
| Browser | 0 / 32 | 788 / 943 | 2 / 2 |

No selected file loses observed passes or gains a timeout. Counts remain
bounded observations, including inherited child reports, as described in the
suite README. Passing more assertions does not establish complete API parity.

Generate the selection and per-cause report with:

```sh
node scripts/bun-suite-small-causes.ts --files
node scripts/bun-suite-small-causes.ts /work/reports/bun-wasm-small-causes
```

Run the selected paths through `scripts/bun-suite.sh --engine <engine> --jobs 2
--timeout 15 --network loopback --dependencies <dependencies> --output <fresh-json>
--log-dir <fresh-logs>` under the suite wrapper. Use the same files and launcher
for each engine.

## Per-cause measurements

| Cause | Engine | Before | After |
| --- | --- | --- | --- |
| transpiler | quickjs | 0/14 files, 9 passes, 0 timeouts | 11/14 files, 65 passes, 0 timeouts |
| snapshot-version | quickjs | 0/13 files, 11 passes, 0 timeouts | 9/13 files, 69 passes, 0 timeouts |
| runner-path | quickjs | 0/9 files, 0 passes, 0 timeouts | 4/9 files, 8 passes, 0 timeouts |
| async-tothrow | quickjs | 0/7 files, 83 passes, 1 timeouts | 2/7 files, 93 passes, 1 timeouts |
| post-run-flags | quickjs | 0/4 files, 0 passes, 0 timeouts | 2/4 files, 2 passes, 0 timeouts |
| decorator-helper | quickjs | 0/4 files, 0 passes, 0 timeouts | 0/4 files, 11 passes, 0 timeouts |
| within | quickjs | 0/4 files, 598 passes, 0 timeouts | 2/4 files, 627 passes, 0 timeouts |
| web-brand | quickjs | 0/3 files, 17 passes, 0 timeouts | 2/3 files, 20 passes, 0 timeouts |
| partial-assert | quickjs | 0/3 files, 6 passes, 0 timeouts | 2/3 files, 26 passes, 0 timeouts |
| resolve-wording | quickjs | 0/4 files, 67 passes, 0 timeouts | 0/4 files, 76 passes, 0 timeouts |
| transpiler | jsc | 0/14 files, 9 passes, 0 timeouts | 11/14 files, 65 passes, 0 timeouts |
| snapshot-version | jsc | 0/13 files, 10 passes, 0 timeouts | 9/13 files, 68 passes, 0 timeouts |
| runner-path | jsc | 0/9 files, 0 passes, 0 timeouts | 4/9 files, 8 passes, 0 timeouts |
| async-tothrow | jsc | 0/7 files, 83 passes, 1 timeouts | 2/7 files, 93 passes, 1 timeouts |
| post-run-flags | jsc | 0/4 files, 0 passes, 0 timeouts | 2/4 files, 2 passes, 0 timeouts |
| decorator-helper | jsc | 0/4 files, 0 passes, 0 timeouts | 0/4 files, 11 passes, 0 timeouts |
| within | jsc | 0/4 files, 598 passes, 0 timeouts | 2/4 files, 627 passes, 0 timeouts |
| web-brand | jsc | 0/3 files, 17 passes, 0 timeouts | 2/3 files, 20 passes, 0 timeouts |
| partial-assert | jsc | 0/3 files, 6 passes, 0 timeouts | 2/3 files, 26 passes, 0 timeouts |
| resolve-wording | jsc | 0/4 files, 15 passes, 0 timeouts | 0/4 files, 24 passes, 0 timeouts |
| transpiler | browser | 0/14 files, 9 passes, 0 timeouts | 11/14 files, 65 passes, 0 timeouts |
| snapshot-version | browser | 0/13 files, 11 passes, 1 timeouts | 9/13 files, 22 passes, 1 timeouts |
| runner-path | browser | 0/9 files, 0 passes, 0 timeouts | 3/9 files, 7 passes, 0 timeouts |
| async-tothrow | browser | 0/7 files, 83 passes, 1 timeouts | 2/7 files, 93 passes, 1 timeouts |
| post-run-flags | browser | 0/4 files, 0 passes, 0 timeouts | 1/4 files, 1 passes, 0 timeouts |
| decorator-helper | browser | 0/4 files, 0 passes, 0 timeouts | 0/4 files, 11 passes, 0 timeouts |
| within | browser | 0/4 files, 598 passes, 0 timeouts | 2/4 files, 627 passes, 0 timeouts |
| web-brand | browser | 0/3 files, 17 passes, 0 timeouts | 2/3 files, 20 passes, 0 timeouts |
| partial-assert | browser | 0/3 files, 6 passes, 0 timeouts | 2/3 files, 26 passes, 0 timeouts |
| resolve-wording | browser | 0/4 files, 64 passes, 0 timeouts | 0/4 files, 71 passes, 0 timeouts |

## Verification and remaining work

On the measured base, all seven new fixtures pass on every engine. The full
fixture gates each report 205 passes and two failures. Both failures reproduce
unchanged on pristine main; the process follow-up in the approved plan records
their exact commands and logs. The full web gate and all six Chromium/WebKit HMR
runs pass.

After merging main `b14f536f`, one batched build job rebuilt the native launcher
and all three wasm artifacts. Each full fixture gate reports 206 passes and one
failure, `node-misc`. QuickJS/JSC exit zero with the known expectation mismatch;
the browser run reaches the fixture deadline with exit 124 during spawn.
All 21 new-fixture engine runs pass. All 80 closed-output checks pass after
PR #52. The full web gate and all six Chromium/WebKit HMR runs pass again.
Neither recorded WebKit flake appeared. No known-main test or implementation
was changed. Exact commands, logs and artifact hashes are in the retained report's
`merged-main/` directory. The batch teardown removes its three Cargo targets.

The adapters remove the missing-method blockers and improve the remaining
diagnostics. Some files still reach additional gaps:

- Transpiler REPL object-literal detection and VM sessions still differ. One
  comma-call simplification differs, and the API error array is not yet capped
  to Bun's 256-message boundary.
- Legacy decorator/metadata tests now collect, then reach metadata and evaluation
  order differences. The TypeGraphQL cases remain incomplete.
- Workspace scripts and tsconfig path aliases remain unavailable.
- Resolver errors have name/code/referrer/notes, but native constructor identity
  and structured `Bun.build` positions remain incomplete.
- EventTarget global methods/brand validation, colored assertion diffs, stream
  matcher helpers, filesystem path-length errors, JSON parser prose and GET-body
  fetch rejection remain separate first failures.

The exact remaining QuickJS first failures follow. Repeat any path on all three
engines with the command above before assigning more work; no upstream source or
snapshot was changed. Raw JSON and complete per-file logs are retained in
`/work/reports/bun-wasm-small-causes/`. The coordinator owns removal after accepting
or reproducing the remaining work.

| File | First remaining named failure | First diagnostic |
| --- | --- | --- |
| `bundler/transpiler/decorator-metadata.test.ts` | decorator metadata > type serialization | TypeError: cannot read property 'length' of undefined |
| `bundler/transpiler/decorators.test.ts` | decorator order of evaluation | error: expect(received).toBe(expected) |
| `cli/install/nested-overrides.test.ts` | syntax > npm object scopes the rule to the parent's edge | 109 \| async function expectVersionsSeenBy(packageDir: string, name: string, expected: Record<string, string>) { |
| `cli/run/tsconfig-override.test.ts` | bun run --tsconfig-override > should use custom tsconfig for path resolution | error: expect(received).toContain(expected) |
| `cli/run/workspaces.test.ts` | bun run --workspaces > runs script in all workspace packages | error: expect(received).toBe(expected) |
| `cli/test/claudecode-flag.test.ts` | CLAUDECODE flag handles no test files found | error: expect(received).toMatchSnapshot(expected) |
| `integration/typegraphql/src/ts_example.test.ts` | <collection/exit> | TypeError: cannot read property 'set' of undefined |
| `integration/typegraphql/src/unsolvable.test.ts` | basic metadata works | error: expect(received).toBe(expected) |
| `js/bun/glob/match.test.ts` | dot segments: **/. with dot = true | error: exit code 1 |
| `js/bun/resolve/resolve-error.test.ts` | ResolveMessage > preserves non-ASCII in position.lineText and position.file | error: expect(received).toBeDefined() |
| `js/bun/test/bun_test.test.ts` | describe/test | error: expect(received).toMatchInlineSnapshot(expected) |
| `js/bun/test/concurrent.test.ts` | concurrent order | error: expect(received).toMatchInlineSnapshot(expected) |
| `js/bun/test/expect.test.js` | expect() > resolves | error: expect(received).toThrow() |
| `js/bun/test/mock-fn.test.js` | mock() > checks the this value > length | error: expect(received).not.toContain(expected) |
| `js/bun/test/only-failures.test.ts` | only-failures flag should show only failures | error: expect(received).toMatchInlineSnapshot(expected) |
| `js/bun/test/test-error-code-done-callback.test.ts` | verify we print error messages passed to done callbacks | error: expect(received).toMatchInlineSnapshot(expected) |
| `js/bun/test/test-test.test.ts` | describe scope throwing doesn't block other tests from running | error: expect(received).toContain(expected) |
| `js/bun/transpiler/repl-transform.test.ts` | Bun.Transpiler replMode > REPL session with node:vm > object literal (auto-detected) | error: expect(received).toBe(expected) |
| `js/bun/transpiler/transpiler-comma-chain-oom.test.ts` | comma simplification output is unchanged | error: expect(received).toEqual(expected) |
| `js/bun/transpiler/transpiler-error-gc-uaf.test.ts` | Log.to_js roots BuildMessage cells across allocation | error: expect(received).toBe(expected) |
| `js/deno/event/event-target.test.ts` | eventTargetAddEventListenerGlobalAbort | ReferenceError: addEventListener is not defined |
| `js/node/assert/assert.test.cjs` | AssertionError diff rendering > colored char diff handles Latin-1, UTF-16 and mixed inputs | error: expect(received).toEqual(expected) |
| `js/node/fs/fs-path-length.test.ts` | callback APIs report a path longer than MAX_PATH_BYTES through the callback > fs.access | error: expect(received).toBe(expected) |
| `js/node/util/test-util-types.test.js` | #11780 | error: expect(received).toBe(expected) |
| `js/web/encoding/encode-bad-chunks.test.ts` | input of type undefined should be converted correctly to string | TypeError: not a function |
| `regression/issue/12782.test.ts` | 12782 | error: expect(received).toMatchInlineSnapshot(expected) |
| `regression/issue/17605.test.ts` | empty and invalid JSON import do not crash | 27 \|   }).toThrow("JSON Parse error: Expected '}'"); |
| `regression/issue/21177.test.ts` | 21177 | error: expect(received).toMatchInlineSnapshot(expected) |
| `regression/issue/25622.test.ts` | child tsconfig paths still work after replacing parent paths | error: expect(received).toBe(expected) |
| `regression/issue/26143.test.ts` | issue #26143 - https GET request with body hangs > Bun.fetch without allowGetBody should still throw | error: expect(received).toThrow(expected) |
| `regression/issue/26207.test.ts` | bun run --workspaces creates node symlink when NODE env points to non-existent path | error: expect(received).toContain(expected) |


## PR review regressions

Native Bun 1.4.2 passes the 12 named public regressions in
`test-review-promises`, `transpiler-review` and `partial-assert-review`.
The frozen pre-fix control `f61b9a9b` returns exit 1 for all three new fixtures
on QuickJS, JSC and browser. The seven existing focused fixtures still pass.
After the fixes, all ten focused fixtures pass on every engine, 30 successful
engine-fixture runs on base `9ced05d7`. The full web gate and all six HMR runs
also pass on that base. Main through `2759d45b` is merged; the final build
verification is recorded in the PR reply and retained report.

The promise regressions cover plain returned objects, real promises with
accessor/overridden then methods, and unawaited checks. The standalone await
observer probe fails before the fix with `second-assimilation`, then preserves
fulfilled object identity with one getter read and ten falsy rejection controls.
Four observer unit tests also verify caught/unawaited rejection identity and
native promise identity when a caller replaces the promise constructor.

Byte tests cover direct TextEncoder results, offset views, DataViews, mutation
after calling transform and transfer of JavaScript-owned backing storage.
Minification covers boolean and object forms, loose boolean fields and invalid
primitive options. Import tests compare transform output and scan results for
default, tree-shaking and explicit trimming settings.

Partial comparisons cover equal/unequal URLs and KeyObjects, one-sided types,
own-property subsets, overridden buffer iterators, genuine typed-array kinds,
DataView/ArrayBuffer numeric properties, and Map fallback without consuming an
entry twice. These assertions do not weaken or replace upstream tests.

The new fixture goldens explicitly preserve this runtime's existing stdout
version-header convention. Native Bun sends that header to stderr, so the
fixtures use manual goldens. A separate existing JSC native-output buffer
transfer gap is recorded in the compatibility follow-up plan.

The paired review builds on `9ced05d7` have the following artifact deltas.
They measure the review corrections, not the whole original PR. Gzip uses the
same Python compression settings and a zero timestamp on both sides.

| Engine | Byte delta | Gzip byte delta |
| --- | --- | --- |
| QuickJS | +2,518 | +545 |
| JSC | +2,510 | +499 |
| Browser | +2,530 | +814 |

Exact commands, control and corrected logs, hashes and size records are under
`/work/reports/bun-wasm-small-causes/review-fixes/`. The coordinator owns removal
after re-review and reproduction of the remaining compatibility follow-ups.
