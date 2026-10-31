# Engine comparison benchmark

Run engine builds through the native Wasmtime launcher and compare six counterbalanced rounds. The default measures `dist/bun.wasm`. Repeat `--engine` to compare builds.

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

# Playground command benchmark

`web/tests/bench-commands.ts` times commands at the playground prompt in a real browser. It
measures from submitting the command to the next prompt, and checks each exit code and output.
Each round opens a fresh browser context. Its first `bun` is the cold start with empty caches.
Warm repeats of every command follow, then a reload and its first `bun`.

```sh
cd web && bun run build
bun tests/bench-commands.ts                       # local preview, Chromium
LATENCY_MS=70 bun tests/bench-commands.ts         # each response 70 ms late, like the live site from Europe
bun tests/bench-commands.ts --url https://bun.sprockt.dev/playground/ --browser firefox
bun tests/bench-commands.ts --network --output /work/tmp/bun-wasm-bench.json
```

`--network` adds `bun add`, `install`, `update`, `remove` and `bun x`, which download from npm.
