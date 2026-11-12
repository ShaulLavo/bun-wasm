# Framework lifecycle measurements

The lifecycle adapters live beside the strict interpreter replay tools in
`scripts/performance/`. They measure the exact Next and Vite React starters.
Replay result equality remains specific to interpreter tracing.

The initial implementation depends on PR 630 at
`73986d5faae6a00130ee7b3be0dd4a22a0881705` and PR 624 at
`c306727b894544e357284d1b6a2dc36b6b28b0c1`. The latter supplies Waffle 0.0.122.
Both heads were integrated into the implementation branch while pending CI.

Next ends at successful process completion with expected build outputs.
Vite ends after rendering the starter and changing its counter from zero to one.
Installation and native preview-browser launch precede timing. Mutable build and
dependency-cache outputs are excluded explicitly from immutable input identity.

PC campaign results are nonquiet experiments. Headless runs are ineligible for
headline performance claims. Timing validity, workload outcome, and observer
coverage are recorded independently. Missing counters remain null with reasons.

## Prepare a host from retained deliveries

Install this checkout's root, `web`, and `sandbox` frozen lockfiles, sourcing
`env.sh` first. Substantial commands use the host's heavy runner. The host
preparation adapter calls `goals-matrix/prepare.ts`; it builds no guest engines.
It adapts the canonical delivery's `site` and `MANIFEST.json` layout into that
producer's delivery schema, preserves its receipts, stages the explicit
SpiderMonkey split pair, and checks the installed Waffle version.

```bash
source env.sh
scratch=$(mktemp -d /work/tmp/bun-wasm-lifecycle-XXXXXX)
export GOALS_CHROME_EXECUTABLE=/work/cache/google-chrome/opt/google/chrome/chrome
bun /work/heavy-runner/current/run.js --host local --class build lifecycle-host -- \
  bun scripts/performance/prepare-lifecycle.ts \
  /work/tmp/bun-wasm-chrome-firefox-guests-20261111 "$scratch" \
  /work/reports/goals/spidermonkey-frameworks/native-performance/pair-split \
  /work/reports/goals/spidermonkey-frameworks/native-performance/pair-split/bun-spidermonkey.wasm.spidermonkey.json
bun /work/heavy-runner/current/run.js --host local --class browser lifecycle-matrix -- \
  bun scripts/performance/lifecycle.ts \
  --host="$scratch/host" --scratch="$scratch" \
  --prepared=/work/tmp/bun-wasm-perf-native-SMxcNK \
  --output=/work/reports/wasm-performance/base-matrix/round-01
```

The caller owns the newly created scratch directory. Remove it after the runner
exits and its servers, native children, and browsers have stopped. Preserve the
coordinator-owned canonical delivery and prepared native source. Do not remove
the prepared host while another lane is copying it.

## Collect and resume runs

`run-list.json` enumerates all 22 configurations. `--cells=id,id` selects their
execution order. Omitting it executes the entire shared-module matrix. A
completed `run.json`, including a failed workload, is retained and skipped on
resume. Use a new output directory for another attempt. Interrupted partial
output is renamed beside the next attempt. An output-directory lock prevents
concurrent writers.

Resume requires the same host assets, maintained drivers, templates, installed-input
inventories, locks, observation mode, and timeout. Comparison identity also covers
the controller, Node/Bun, explicit Chrome executable, Firefox executable and engine,
Playwright implementation, kernel, effective CPU allowance and display environment.
Set `GOALS_CHROME_EXECUTABLE` even for a selected native subset so a resumed sweep
has one defined browser configuration. Inputs are hashed before
execution. Host assets are checked again afterward. Native installed copies
must match their prepared inventories, preserve relative symlinks, and match
the checked-in starter source. Per-run immutable hashes exclude only declared
generated roots and are checked after completion. The guest lock conversion
must preserve every package resolution and integrity value, then pass a frozen
installation before the final cache reset.

The command exits successfully when collection completes. Workload failures
remain explicit in each record and in the generated summary. A failed cell
does not terminate collection of the remaining configurations.

Each run saves command, environment, runtime observation, cache reset,
outcome, and timing evidence. Raw install logs, terminal text, guest locks,
and guest file inventories remain alongside browser runs. Native stdout and
stderr remain alongside native runs. Missing outputs have null sizes with
reasons. Polling endpoints carry observation brackets, not a fixed error bound.
The native endpoint observes process closure; it is not a kernel exit timestamp.
Browser requests use separate preparation and measurement deadline scopes. Cleanup
has an independent deadline and still runs after measurement cancellation.
Execution evidence separately brackets browser launch and navigation to runtime
readiness. Readiness includes any transfer, preparation, compilation and shell
startup in that envelope; it does not isolate compilation alone.
`execution.json` preserves each acquired observation even if the adapter throws;
unreached observations remain unavailable with a reason. Each invocation has its
own environment and host-verification record under `invocations/`. The original
campaign environment is preserved. Timings remain provisional until host checks
finish; failed verification invalidates affected timings without changing workload
outcomes. Summaries honor both recorded timing validity and the source invocation's
verification, including when reading an explicit list of records.

`--mode=selection` supports separate native runs with the same cell IDs in a new
output directory. It preloads `lifecycle-selection.ts` into the actual runtime
invocation and records context identities, successful addon loads, and Wasm
compilation or instantiation hashes. Each preloaded context runs a tiny Wasm
control before the job. Internal loader paths, streaming compilation, and
contexts without the preload remain outside coverage. Selection timings do not
enter baseline distributions. Compiler forcing is deferred.

`summary.json` and `SUMMARY.md` show the current sweep. To summarize an explicit
list of retained records, supply a JSON array of `{ "id": "...", "record":
"/absolute/run.json" }` entries to:

```bash
bun scripts/performance/lifecycle-summary.ts OUTPUT RUN-LIST.json
```

There is no complete wall-time partition, polling CPU attribution, or inferred
blocked time. CPU counters and profiles are unavailable in this base adapter.
`/proc` process snapshots identify observed binaries, arguments, and affinity;
they can miss short-lived children. Sysfs records online CPUs, SMT siblings, and
the available hybrid PMU CPU groups. All PC runs remain nonquiet experiments.
