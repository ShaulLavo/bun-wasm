# Scoped lifecycle profiles

The lifecycle profiler extends the saved-worker boundary reader in `scripts/performance/profile.ts`. It keeps inclusive detours, useful Wasm callees and structural boundary samples separate. Nested rows overlap; aggregate shares use sample unions.

Capture support is conditional on an executable control in the selected browser and guest engine. A child worker must start and exit inside the capture window and retain identifiable computation samples. Failure leaves attribution unavailable without invalidating baseline timings.

Source `env.sh` before preparation or execution. Prepare a private current-source Waffle 0.0.122 host from frozen guests with `scripts/performance/prepare-lifecycle.ts`, as described in [lifecycle measurements](performance-lifecycle.md). Keep host and guest sources separate. The native prepared fixture supplies its frozen dependency lock; the profiler never changes that fixture.

Run each command through the machine's workload runner. These commands name already prepared inputs and new output directories:

```sh
bun scripts/performance/lifecycle-profile.ts HOST PREPARED OUTPUT/control chrome quickjs control
bun scripts/performance/lifecycle-profile.ts HOST PREPARED OUTPUT/next chrome quickjs next OUTPUT/control/run.json
bun scripts/performance/lifecycle-profile.ts HOST PREPARED OUTPUT/next-off chrome quickjs next-off OUTPUT/control/run.json
```

Set `GOALS_CHROME_EXECUTABLE` to genuine Google Chrome. Use `firefox` for the installed Playwright Firefox. Engines are `browser`, `quickjs`, `jsc` and `spidermonkey`; this adapter uses split guests. `vite` and `vite-off` replace the Next phases for a runnable Vite configuration. A failed base runtime prerequisite remains a failure, rather than a reason to retry it for profiling.

The control performs known computation in a guest process and its child. Actual workload commands require a passed control for the identical browser, engine and host inventory. Controls run in separate browser roots before the workload's application-cache reset. Next requires successful exit and its expected output files; Vite requires render and counter checks. Installation stays outside the command window. OS page and browser compilation caches remain uncontrolled.

Chrome uses browser tracing and worker target timestamp markers. The reader joins CPU chunks by process and profile ID, preserving the profiled thread ID from the initial record rather than the sampler thread that emits later chunks. Its control requires timestamp-linked worker birth, computation samples and exit inside the observation window. Capture can include page and infrastructure profiles; each result retains its individual process/thread/worker scope. Missing worker annotations remain unmapped.

Firefox uses startup profiling and a shutdown capture. Each process's epoch time origin restricts samples to the command observation window. Its control requires retained root/child computation and registration/unregistration inside that window. Raw mixed native, Wasm and JavaScript stacks do not establish the Chrome reader's structural crossing classification. Unknown native leaves remain unknown. The innermost named-frame table skips unresolved native addresses but does not relabel them as JavaScript self time. Filtering symbolically named waits does not prove remaining samples were on CPU.

Each run saves source labels, actual launch processes where observable, worker events, terminal text, command window, cleanup and observer outcome. Analysis reports actual sample counts, included/excluded kinds, unknown leaves and stripped Wasm symbols. All supplied Chrome sample entries have equal weight, including idle, program and GC entries. Elapsed profile duration and per-entry time deltas are not thread CPU. Gecko uses all selected DOM Worker entries, including empty and unresolved stacks. Other roles remain excluded.

To re-read a retained capture without replacing its original result:

```sh
bun scripts/performance/lifecycle-profile-analysis.ts CAPTURE_DIRECTORY
```

The reader accepts the original trace/profile or its `.gz` copy and creates `reanalysis.json`. This allows parser corrections on saved samples without rerunning a job. Keep the original record when a parser or capture failed. Successful capture writes compressed raw evidence; the run owner may remove the uncompressed duplicate after its consumers stop. Reanalysis is analysis evidence, not a new measurement.

Samples can retain JavaScript frames around blocking waits. Large shares in a host worker therefore do not establish host CPU cost. Profiles describe only their recorded workers, phases and sample kinds. Unknown or stripped symbols stay unknown. Shares do not decompose lifecycle wall time or establish a speedup. Firefox crossing shares require particular care because profiling can amplify crossings. Actual workload observer-on/off runs provide sensitivity evidence, with shared-host variation reported separately.
