# Cumulative main CI selection

Pushes to main share one workflow concurrency group. GitHub preserves its running
member and replaces its pending member. PR cancellation and isolated manual runs
keep their existing behavior. Old uniquely grouped runs are unaffected.

The main-only `Resolve cumulative main coverage v1` step in the successful
`CI selection` job is the baseline marker.
Only a successful whole CI workflow with a successful Code quality job and that
successful marker qualifies. The helper verifies workflow ID and path, push/main,
immutable SHA and the successful run's exact attempt. Runs with the marker in
the former Source quality job cannot bootstrap coverage. The first successful
selection-marked run establishes a new baseline after selecting all families.
A rerun uses its own attempt's jobs.

The helper walks the immutable head's first-parent chain nearest first and queries
successful runs for each exact ancestor SHA. API ordering and rerun ordering do
not choose the baseline. It ORs the existing classifier across every intervening
parent/child edge, with no rename detection and check manifests from both ends.
Immutable manifest reads are cached across edges. Package version exclusions
remain per edge, including the existing shared-sysroot package input rule.

Lookup is limited to 64 edges, 80 total API requests, 24 candidate job inspections
and a 30-second budget checked between reads. Network requests share a 30-second
abort signal. Every Git subprocess has a five-second deadline, so in-flight Git
reads can finish after the budget before the next check. Missing or malformed
history, API errors, bounds or absent proof select all four conditional families.
A successful bootstrap establishes the baseline; later docs-only ranges can skip
native work again. Immutable comparison validation still runs first for all events.

The feature test is discovered by `checks/quality-ci-main-coverage.json`. It uses
temporary local repositories and mocked read-only Actions responses. Hosted queue
behavior and throughput require observation after merge; no speedup is measured
by these source tests.

## Local verification

After `source env.sh`, this source/contract selection passed 853 tests in 15 seconds:

```sh
TMPDIR=/work/tmp bun test scripts/{ci-main-coverage,ci-changes,ci-pr-policy,ci-refs,ci-check-inputs,ci-cache-inputs,ci-jsc-prebuild,shared-sysroot-ci,spidermonkey-shared-ci,test-checks,ci-quality}.test.ts
```

Three final CLI tests were then added. The final coverage-only rerun passed all
41 tests. Check discovery passed, including quality-owner discovery of the new
manifest. Targeted strict TypeScript and oxlint passed for all changed scripts;
actionlint 1.7.12 with shellcheck 0.11.0 passed the workflow. The repository-wide
`bunx tsc -p tsconfig.scripts.json --noEmit` remains blocked by missing installed
`@xterm/addon-fit` and `@xterm/xterm` declarations in `web/src/terminal-mount.ts`.
No dependency manifests were changed for that installation problem.

A parsed YAML comparison against parent head `08370f9d3` confirmed every downstream
job is unchanged, including transfer deadlines and fixture environments. Temporary
coverage repositories were removed and checked on the execution host.
