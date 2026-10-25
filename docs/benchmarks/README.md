# Engine comparison benchmark

Run engine builds through the native Wasmtime launcher and compare seven alternating rounds. The default measures `dist/bun.wasm`. Repeat `--engine` to compare builds.

```sh
source env.sh
bun scripts/bench-engines.ts \
  --engine quickjs=dist/bun.wasm \
  --engine jsc=dist/bun-jsc.wasm \
  --runs 7 --output /work/tmp/engine-results.json
```

`scripts/bench-jsc.sh` keeps the old QuickJS-versus-JSC entry point. The native launcher defaults to `$BUN_WASM_LAUNCHER`, `bun-wasm` on `PATH`, then `$CARGO_TARGET_DIR/release/bun-wasm`.

The runner measures `bun run` hello with Wasm compilation, hello from a populated compiled-module cache, `bun -e`, the existing micro CPU suite, and a bundled TypeScript compiler load. It checks hello/eval output, all five micro checksums, and the compiler parse result. The large bundle is generated in scratch from the pinned `typescript-api` dependency and deleted afterward. Its size and hash go in the JSON report.

Wall time starts before launcher spawn and ends after guest exit. It includes process launch, Wasm module loading, Bun bootstrap, and the workload. Cold hello sets `BUN_WASM_CACHE_DIR=off`. Other workloads use a per-engine Wasmtime cache populated by one unmeasured run. This is compiled-module reuse, not JavaScript bytecode caching. No OS caches are flushed and no samples are discarded.

Peak RSS comes from the child process resource usage after exit. It covers native Wasmtime, its compiled code, guest linear memory, and, on cold runs, the compiler. It is not a guest linear-memory or GC-heap measurement. The Wasmtime CLI and this launcher expose no linear-memory high-water counter. Micro guest times come from the suite's own `performance.now()` readings.

The JSON report records every argv, stdout, stderr, wall time, RSS sample, artifact hash, and median. Use the quiet benchmark queue on the maintainer's PC.
