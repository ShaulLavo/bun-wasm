# Runtime JavaScript measurement

Measure before considering engine bytecode. Preserve lazy modules. A source inventory
is not a list of modules parsed during startup.

The native baseline uses the producer's original launcher smoke invocation. It verifies
the current split producer closure at `manifest.json`, hashes every listed artifact,
requires the complete three-engine artifact registry, and checks the launcher against
its original receipt and the closure source identity. It records those hashes in
`inputs.json`. Keep that file with the samples. The closure's engine receipts bind the exact engine/build inputs;
module names and evaluated byte lengths identify individual runtime records.

Run through the normal bench queue when higher-priority Next work is idle. Use an
existing shared Wasmtime cache without clearing it and a new results directory:

```sh
source env.sh
BUN_WASM_CACHE_DIR=/path/to/existing/wasmtime-cache \
  bun /work/platform-production/heavy/current/run.js --class bench runtime-js-cost -- \
  nice -n 10 bun scripts/measure-runtime-js.ts /path/to/original-producer-unit /path/to/results
```

An active `.producer-lock` is rejected. The script reads `dist/` directly from the
canonical closure and uses the producer's engine registry. It runs three fresh processes
per workload per engine, alternating engine order.
`eval1` runs exactly `-e 1`. `first-fs` times the first `require("fs")` in the guest and
checks cached identity on a repeat. All raw stdout, stderr and invocations are retained.
There are no fixture files, services or routes to remove. The heavy runner owns process
group teardown on interruption. Preserve the original artifacts and shared cache.

## Opt-in records

Only a canonical build containing the instrumentation emits runtime scopes. Set
`BUN_WASM_MEASURE_RUNTIME_JS=1` on the benchmark command to pass the same opt-in to the
guest. Default evaluation order, wrappers and lazy cache behavior are unchanged.
With the flag absent, the cached enabled check goes straight to the original operation,
without timing calls, formatting, emitted records or tracking allocations.

Records on stderr begin with `[bunwasm:runtime-js]` and include the engine, stage,
stable module name, source bytes, process-local id, parent id, elapsed nanoseconds and
success/error status. Source text is never logged. The runtime retains only counters
and the active parent, with no per-module history.

The internal builtin loader uses the private `evalBuiltin` operation for
`builtin-eval` records. Generic `evalScript` calls remain unmeasured even when user
code supplies a filename starting with `bun-builtin:`. The filename alone never
classifies user code as a runtime builtin.

| Stage | What its inclusive time covers |
| --- | --- |
| `source-load` | Runtime polyfill source retrieval across the core/side boundary, including transport and allocation. Bytes are zero because length is unavailable before retrieval. |
| `factory-eval` | Evaluating a runtime factory expression, including source conversion, parsing, compilation and expression execution. Excludes source retrieval and the later factory call. |
| `builtin-eval` | The same evaluation bucket for generated Bun builtins reached through the internal `bun-builtin:` loader. Excludes source retrieval and the later factory call. |
| `bootstrap-execute` | Calling the bootstrap factory. Includes its nested source loads/evaluations, factory calls, native calls and deferred compilation. Bytes are zero because this is a call, not a source load. |

Every record is inclusive. Never add the bootstrap record to its nested children.
The script sums only root records and derives stage-exclusive residuals by subtracting
each record's immediate children. Child logging/instrumentation overhead remains in
the parent's residual. These residuals are not pure factory execution or parse time.
No records means unknown, represented by `null`, never zero.

## Attribution limits

Whole-command wall time includes native Wasmtime cache lookup or compilation,
instantiation, engine creation, runtime setup, user execution and disposal. No fraction
of that total is claimed as parsing. Cache file counts cannot prove a hit or separate
Wasmtime compilation. First-require time includes resolution, retrieval, compilation,
initialization and cache population. The cached repeat is not a parse-time control.

The maintained scopes are upper bounds on work containing compilation. They exclude
engine creation, user code evaluation and unmeasured runtime native installation. They
do not separate parse-only cost or capture every later lazy function compilation.

* QuickJS currently calls `JS_Eval2` without `JS_EVAL_FLAG_COMPILE_ONLY`. Its pinned
  headers expose that flag, `JS_WriteObject`, `JS_ReadObject` and `JS_EvalFunction`.
  A compile-only experiment would change that path and needs separate authorization.
* JSC's maintained helper calls `JSC::evaluate` with `SourceCode`, combining parsing,
  compilation and execution. Its internal `SourceProvider` bytecode-cache API is not
  exposed by our shim. `JSCheckScriptSyntax` is not compile-cost attribution.
* Hermes's `bh_eval` calls `createBCProviderFromSrc` then `runBytecode`. These are
  separable in C++, but not through the current shim. Our VM enables lazy compilation
  above 64 KiB unless optimization is enabled. Initial evaluation omits compilation
  performed by later calls. Do not change those flags to make a timing look cleaner.

Future bytecode must bind the exact engine revision and build flags, target/ABI,
runtime/generated-source hashes, compiler options and original wrapper/line metadata.
An engine name or bytecode format number alone is insufficient. No bytecode cache is
implemented here.

## Short checks and canonical input

Run `bun test scripts/measure-runtime-js.test.ts`. Test the standalone Rust helper by
including `runtime_js_measurement.rs` as a module in a tiny `rustc --test` harness.
Tests cover disabled clocks and emission, nested parent restoration, errors, and panic
unwinding. The TypeScript checks also exercise the real builtin loader, keep generic
evaluation outside builtin measurements, and verify blocking CI discovery. The
quality check manifest selects these tests. This does not verify a built three-engine binary.

The single future build input includes the shared evaluator, its adjacent helper,
the builtin loader and its native declaration, the measurement script, its tests,
and the quality check manifest. The existing canonical producer consumes this source.
No second producer or engine cache should be created. Preserve the retained baseline and
collect matching opt-in/off samples from that one canonical build before deciding
whether compilation is a significant cost worth replacing with bytecode.
