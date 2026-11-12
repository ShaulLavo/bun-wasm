# Compiled-plan sharing experiment

This diagnostic compares the default split profile using Waffle 0.0.122 with the same source and guest bytes prepared separately in each worker. It changes no shipping source. Run `scripts/performance/prepare-sharing.ts EMPTY_SCRATCH CANONICAL_DELIVERY SM_PAIR SM_RECEIPT` after the normal frozen root, web, and sandbox installs and `source env.sh`. Preparation uses the lifecycle adapter and goals producer. The generated control patch and guest fingerprints are retained in scratch.

The control keeps the original core and side link source in page metadata and clones it with each worker request. Workers prepare that source instead of adopting the shared compiled plan. Direct worker preparation intervals include validation, transformations and compilation. Source retention and cloning add allocation and transfer work. The experiment measures this complete strategy. Browser internal caching of identical bytes can still occur. Shared-group memory is a different feature and is rejected by this control.

Use fresh lifecycle output directories for each site and observation condition. Timing, external observations and profiles remain separate. Headless nonquiet PC results are experimental.

`lifecycle.ts --mode=controls` runs finite CPU/filesystem root, child and nested fixtures in the selected browser/engine. The unshared paired engines must show direct preparation records. The browser-engine guest is a single module and has no paired link plan to reprepare.

`--mode=observation` runs exact-context controls and samples Linux `/proc` at a requested 250 ms interval, after each completed sample. It writes separate observation files. Browser roots come from Playwright's launched browser process, with executable and process/thread start identities checked through `/proc`. The harness and asset server are excluded. Native framework and matching preview-browser trees have separate files. No roles or filesystem-service identity are inferred from names or birth times. Unavailable controls leave attribution unavailable while the framework still runs.

Raw samples include actual controller monotonic timestamps, UTC timestamps, task CPU ticks, available `schedstat` counters, affinity, process RSS/PSS, task faults and host memory/CPU pressure. Raw scheduler statistics and the enablement flag remain recorded. Queue output is unavailable on every host until a wait-specific positive control and its provenance exist; enablement or advancing runtime alone never admits a number. Missing entries and reads remain visible. Entire short-lived processes/threads and final CPU tails can be missed. Peaks are sampled; shared pages can be counted more than once by summed RSS. CPU seconds and queue seconds are separate from wall time and never form a wall partition.

Use `--mode=observation` and `--mode=observer-off` for observer-on and observer-off conditions. Both execute the same controls before the cache reset; only the observation condition samples the measured job. Run both conditions on the same host/site with new output directories. Observation wall times are diagnostic annotations and excluded from timing distributions. Keep their raw differences as overhead sensitivity, with workload variation and shared-host contention unresolved. Profiles and the existing instruction counter remain separate tools; this observer adds no counter.

For each workload, these selections cover all eight browser-engine cells:

```sh
source env.sh
export GOALS_CHROME_EXECUTABLE=/work/cache/google-chrome/opt/google/chrome/chrome
# Set to a task-owned prepared pair and a new report destination.
export PERF_PAIR=/work/tmp/your-owned-sharing-pair
export PERF_RESULTS=/work/reports/your-owned-sharing-results
for workload in next vite; do
  cells="${workload}-chrome-browser-split,${workload}-chrome-quickjs-split,${workload}-chrome-jsc-split,${workload}-chrome-spidermonkey-split,${workload}-firefox-browser-split,${workload}-firefox-quickjs-split,${workload}-firefox-jsc-split,${workload}-firefox-spidermonkey-split"
  bun /work/heavy-runner/current/run.js --host local --class browser sharing-unshared -- \
    bun scripts/performance/lifecycle.ts --scratch="$PERF_PAIR" \
    --host="$PERF_PAIR/unshared/host" --prepared=/work/tmp/bun-wasm-perf-native-SMxcNK \
    --output="$PERF_RESULTS/$workload-unshared" --cells="$cells"
done
```

The same command with the shared host supplies a paired condition. Interleave repeated conditions; one pass is exploratory. Use `--mode=controls` for the eight startup controls and `--mode=observation` for separate sampled cases. Keep prior failures; a new condition does not repair a runtime prerequisite. Vite's known split-engine compiler failures and Firefox JSC's unknown Next spawn failure remain existing outcomes.

Native preview positive controls use the invocation abort signal and a deadline capped at five seconds. Failure finalizes polling and closes the affected preview. A surviving invocation can create a fresh unobserved preview before the framework window; cancellation reaches native teardown.
