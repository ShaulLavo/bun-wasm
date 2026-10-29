# Compare current engine artifacts

Use `scripts/bench-engines.ts` for native startup and checked CPU/compiler workloads. It accepts QuickJS, JSC, and Hermes artifact paths without building them. Verify the canonical producer closure first. A preparing or historical closure cannot support a current comparison.

```sh
source env.sh
bun scripts/bench-engines.ts \
  --engine quickjs=/ABS/dist/bun.wasm \
  --engine jsc=/ABS/dist/bun-jsc.wasm \
  --engine hermes=/ABS/dist/bun-hermes.wasm \
  --producer-manifest /ABS/manifest.json \
  --protocol /ABS/protocol.md --runs 6 --output /ABS/new-window.json
```

Six rounds use all six engine permutations. Each workload records raw observations and min, median, nearest-rank p90, max, and MAD. Fewer than six observations or relative MAD above 10% flag weak timing evidence. No samples are discarded. Cold disables the Wasmtime module cache; precompiled reuses an isolated warmed compilation cache. Every sample starts a fresh JS VM. Neither mode flushes OS page caches.

The runner writes an exclusive `new-window.json.protocol.json` before warming or measuring any engine. It records workload order, fixture and bundle digests, source commit/tree, protocol and producer manifest, launcher, core and companion digests. Existing output identities are rejected. The producer verifier owns manifest validation; recording a manifest does not certify it.

`--native-control --runs 1` exercises the same workload/output pipeline with native Bun. These results are labelled `native-control-only` and carry no engine artifact identity. They validate the runner, not Wasm performance or a complete comparison.

Native peak RSS covers the whole child process, including the benchmark parent's memory inherited at fork, Wasmtime, and compilation. It is diagnostic only. Guest capacity, allocator live/peak, engine heap, backing stores, and SWC remain null here. Use the producer hook with the existing application acceptance driver for those counters. Never sum overlapping engine estimates or substitute capacity for live memory.

Register a bounded product census with `bun scripts/engine-comparison.ts --register --apps vite-react,hono,typescript,next-16-app --host playground --rounds 1 --output /ABS/new-plan.json`. The plan derives required command and probe stages from the existing catalog and emits existing matrix argv. It does not run them. Replay the registry offline after staging verified artifacts in this checkout's `dist/` and `web/dist/`. One census is experimental; `--rounds 6` emits the balanced campaign when its cost is justified.

Reduce each round with `bun scripts/engine-comparison.ts --plan /ABS/new-plan.json --report /ABS/round-0/results.json --output /ABS/new-summary.json`. Repeat `--report` for disjoint engine reports from that round. Duplicate cells and fixture digests that differ from registration are rejected. Missing entire engines produce not-run cells. Summaries retain input provenance and report digests. App passes require every registered stage, including probes. Successful stage latency is included only where the existing matrix recorded `durationMs`; unavailable times stay null. Reduce six rounds separately and retain their raw observations for paired analysis.

Reuse the existing product app matrix for acceptance and application-stage speed. Register the expected app/stage cells before running. Missing and blocked cells remain in the denominator. Separate hosts and retain every input report's fixture, runtime artifact, browser, and registry identity. A native control, incomplete census, or headless diagnostic cannot choose the default engine. The owner makes that decision from current matched artifacts and numbers.
