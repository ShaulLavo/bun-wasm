# Interpreter replay tools

Unit G keeps diagnostic measurements separate from lifecycle acceptance. The
tools accept explicit artifacts and output roots. They do not build engines or
change product tiers, flags, observers, or deadlines.

Build the Linux counter without the guest toolchain dependencies:

```sh
source env.sh
rustc --edition 2024 -O crates/bunwasm-tools/src/bin/instruction-count.rs -o /work/tmp/instruction-count
taskset -c 8 /work/tmp/instruction-count /work/tmp/count.json 10 /usr/bin/true
```

The counter supervises the complete inherited process tree, including orphaned
descendants. It counts user-space machine instructions and cycles, excludes
kernel and hypervisor work, and records each PMU's enabled and running times.
Unavailable counters, zero aggregate counts, timeouts, signals, and coverage
below 99 percent fail the capture. Output paths must be new.

On hybrid CPUs, pin to CPUs belonging to one PMU before starting the counter.
It selects that PMU and fails if affinity spans both kinds. Descendants must keep
the inherited affinity. A Linux permission or counter failure is an error, never
a zero-valued result. Child failures preserve their exit code. Signals HUP, INT,
QUIT, PIPE and TERM and the deadline stop and reap descendants, including new
sessions. SIGKILL and machine failure cannot run teardown.

Create one explicit JSON plan per arm. It records `workload`, `arm`, `mode`,
`configuration`, `sourceRevision`, `observer`, `counter`, `cpu`, `timeoutSeconds`,
`cwd`, a complete `env`, explicit `cacheRoots`, the expected `control` object,
`inputs`, and an argv `command` with exactly one `{mode}` argument. Executable
paths are absolute. Each input has `path`, `kind` of `file` or `tree`, `sha256`,
and `role`. Required roles are `fixture`, `source`, `flags`, `executable` and
`counter`. Include the core, side, shell utilities, lockfile and installed tree
as applicable. Preserve the actual source and flag recipe files beside the plan.
The runner verifies inputs before and after each capture. Tree hashes cover
sorted file contents and symlink targets; external symlinks fail.

```sh
source env.sh
bun scripts/performance/input.ts tree /work/tmp/input /work/tmp/inventory.json
bun scripts/performance/capture.ts PLAN.json NEW_OUTPUT --establish-control warmup
bun scripts/performance/capture.ts PLAN.json NEW_OUTPUT ORACLE/result.json warm
bun scripts/performance/replay.ts BEFORE.json AFTER.json ORACLE/result.json NEW_OUTPUT
bun scripts/performance/profile.ts SAVED_CHROME_PROFILE.json NEW_OUTPUT.json
```

Establish the unchanged control first and retain its `result.json` as the output
oracle. Every capture runs the positive control through the exact same executable,
flags, cwd, environment and affinity as the workload. Only `{mode}` changes.
Missing markers, full result/count/warning drift and stub use fail. The positive
control can compile and warm artifacts, so the tool makes no cold-workload timing
claim. It records cache entry counts before that control and saves its counters
separately. `warmup` is excluded from comparisons even when a cache already
exists. Compilation remains in the actual capture that performs it.

`replay.ts` runs A warmup, B warmup, A, B, B, A. It retains every successful result,
counter, stdout, stderr, input plan and error. `runs.json` contains full records;
`summary.json` reports all warm values, median and range for each arm's wall,
CPU and instructions. It checks matching workload, mode, fixture, cwd, observer,
environment, cache roots and affinity. Each arm retains its own source, flags
and artifact identities. Interpret the actual difference between those recipes.
There is no global denominator or automatic comparison across workloads.

Use `tests/performance/fixtures/real-guest.ts` for the production path adapter.
Copy it into a frozen installed starter as `perf-trace.ts`, then invoke
`bun run perf-trace.ts {mode}` inside the guest. Modes are `control`, `trace`, and
`load`. It uses guest node:path, filesystem and module loading. Output includes
complete sorted file and ESM lists, warnings, entry/ignore configuration, package
identities and callback counts. `readStringLength` counts JavaScript code units.

Use `nft-replay.cjs` with explicit frozen JSON only for pure interpreter replay.
Its modes are `control`, `replay`, and `load`. It substitutes path-browserify and
recorded callbacks, so it does not measure the production path adapter. The tiny
`replay-small.json` is an original tool control. The retained audit's full JSON
is supplied separately by its owner, outside the release payload. Its original
SHA-256 is `a0fabafcb566ae4bc75de4b1e90f9c1ec57451861f6a90a2e5425cb9edd2dac5`.
See [the classified record](bun-patches/performance-replay.md) for provenance.

Use `sm-shell-x86_64-interp` for the genuine native reference and
`sm-wasmtime-wasm32-interp` for Wasm under the launcher. `tool-test` is reserved
for tool controls. Chrome is `sm-chrome-wasm32-interp`; the counter command does
not claim browser-process coverage. The profile command reads one saved Chrome
worker capture. It counts actual `samples` entries, reports useful Wasm callee
work separately from structural boundary overhead, and rejects absent captures.
Inclusive rows can overlap; reported totals use sample-node unions. Samples do
not measure complete lifecycle CPU or prove profiler overhead is absent.

Run `bun test scripts/performance-tools.test.ts` after sourcing `env.sh`. Hardware
checks exercise real processes and threads when perf is available; unavailable
hosts verify fail-closed behavior and report the limitation. The test owns and
removes its binaries, descendants and scratch. External installs and caches stay
with the caller, who records their cleanup owner and removal condition. These
diagnostics never change lifecycle deadlines or earn campaign credit.
