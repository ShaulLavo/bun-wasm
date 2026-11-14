# Scoped lifecycle profiles

The lifecycle profiler extends the saved-worker boundary reader in `scripts/performance/profile.ts`. It keeps inclusive detours, useful Wasm callees and structural boundary samples separate. Nested rows overlap; aggregate shares use sample unions.

Capture support is conditional on an executable control in the selected browser and guest engine. A child worker must start and exit inside the capture window and retain identifiable computation samples. Failure leaves attribution unavailable without invalidating baseline timings.

Source `env.sh` before preparation or execution. Prepare a private current-source Waffle 0.0.130 host from frozen guests with `scripts/performance/prepare-lifecycle.ts`, as described in [lifecycle measurements](performance-lifecycle.md). Keep host and guest sources separate. The native prepared fixture supplies its frozen dependency lock; the profiler never changes that fixture.

Run each command through the machine's workload runner. These commands name already prepared inputs and new output directories:

```sh
bun scripts/performance/lifecycle-profile.ts HOST PREPARED OUTPUT/control chrome quickjs control
bun scripts/performance/lifecycle-profile.ts HOST PREPARED OUTPUT/next chrome quickjs next OUTPUT/control/run.json
bun scripts/performance/lifecycle-profile.ts HOST PREPARED OUTPUT/next-off chrome quickjs next-off OUTPUT/control/run.json
```

Set `GOALS_CHROME_EXECUTABLE` to genuine Google Chrome. Use `firefox` for the installed Playwright Firefox. Engines are `browser`, `quickjs`, `jsc` and `spidermonkey`; this adapter uses split guests. `vite` and `vite-off` replace the Next phases for a runnable Vite configuration. A failed base runtime prerequisite remains a failure, rather than a reason to retry it for profiling.

The control performs known computation in a guest process and its child. Actual workload commands require a passed control for the identical browser, engine, host inventory, committed source and collector configuration. Browser executable, version and headless mode are checked after launch before any workload preparation. Controls run in separate browser roots before the workload's application-cache reset. Next requires successful exit and its expected output files; Vite requires render and counter checks. Installation stays outside the command window. OS page and browser compilation caches remain uncontrolled.

Chrome uses browser tracing, command boundary markers and worker target timestamp markers. The reader accumulates each signed sample delta in Chrome's trace clock, then selects entries inside the recorded command markers. It never guesses an offset from the controller's epoch clock. These markers bracket command submission and completion observation; they do not establish an additive wall partition or turn sample intervals into CPU time. A saved capture without those markers retains a wider capture scope and cannot certify exact workload attribution or its control.

The collector requests only `disabled-by-default-v8.cpu_profiler` and `blink.user_timing`, with other categories excluded, a fixed 512 MiB `recordUntilFull` buffer, requested as 524288 KiB, and buffer usage reports every second. Command and worker identity markers use `performance.mark`; their instant user-timing events carry the marker name and trace timestamp. `chrome-retention.json` records the accepted start request, buffer telemetry, completion loss flag and stream completion. Exact-scope capability requires both unique command markers, worker lifetime evidence, meaningful samples, complete stream retention, unsaturated telemetry and trace buffer statistics without discarded or overwritten data. Missing evidence or reported loss fails closed. Old captures without telemetry remain diagnostic wider captures even if both markers exist.

A validated source-only `ProfileChunk` whose data is exactly `{ "source": "Internal" }` is metadata and contributes no samples. It cannot create a sampled profile or repair incomplete node/sample data. The strict single-worker reader and its CLI remain unchanged.

The reader joins CPU chunks by process and profile ID, preserving the profiled thread ID from the initial record rather than the sampler thread that emits later chunks. A worker identity requires one temporal marker within that profile's lifetime and matching target lifetime evidence. Samples before the identity marker are excluded from that worker's subset. Missing or contradictory lifetimes and profiles spanning multiple markers remain unmapped. The control also requires distinct root/child identities with observed birth, computation and exit inside the controller window. The controller and trace clocks remain explicit and separate.

Firefox uses startup profiling and a shutdown capture. Each process's epoch time origin restricts samples to the intersection of the command window and known registration/unregistration bounds. Duplicate or contradictory worker identities are rejected. Its control requires two distinct process-origin/pid/tid/registration identities with retained root/child computation inside those lifetimes. Raw mixed native, Wasm and JavaScript stacks do not establish the Chrome reader's structural crossing classification. Unknown native leaves remain unknown. The innermost named-frame table skips unresolved native addresses but does not relabel them as JavaScript self time. Filtering symbolically named waits does not prove remaining samples were on CPU.

Each run saves source labels, actual launch processes where observable, worker events, terminal text, command window, cleanup and observer outcome. Analysis reports actual sample counts, included/excluded kinds, unknown leaves and stripped Wasm symbols. All supplied Chrome sample entries have equal weight, including idle, program and GC entries. Elapsed profile duration and per-entry time deltas are not thread CPU. Gecko uses all selected DOM Worker entries, including empty and unresolved stacks. Other roles remain excluded.

To re-read a retained capture without replacing its original result:

```sh
bun scripts/performance/lifecycle-profile-analysis.ts CAPTURE_DIRECTORY
```

The reader accepts the original trace/profile or its `.gz` copy and creates `reanalysis.json`. This allows parser corrections on saved samples without rerunning a job. Keep the original record when a parser or capture failed. Successful capture writes compressed raw evidence; the run owner may remove the uncompressed duplicate after its consumers stop. Reanalysis is analysis evidence, not a new measurement.

Samples can retain JavaScript frames around blocking waits. Large shares in a host worker therefore do not establish host CPU cost. Profiles describe only their recorded workers, phases and sample kinds. Unknown or stripped symbols stay unknown. Shares do not decompose lifecycle wall time or establish a speedup. Firefox crossing shares require particular care because profiling can amplify crossings. Actual workload observer-on/off runs provide sensitivity evidence, with shared-host variation reported separately.
