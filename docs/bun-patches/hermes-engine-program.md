# Hermes engine program

Source integration record for the third linked engine program, `hermes-engine.wasm`, on
bun-wasm `404a956ffdf3fbee9c94b4875be0afe3fbe09df5`. The Hermes VM, its patch and the C shim
are recorded separately ([Hermes on WASI](hermes-wasi.md),
[async context](hermes-async-context.md)). Design: `docs/hermes-engine.md`.

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-engine-hermes/src/lib.rs`, `Cargo.toml` | Port | Original registration and entry adapter, the JSC side's `lib.rs` with `hermes_` names. It compiles the shared program sources (`crates/bunwasm-engine-quickjs/src/{driver,allocator,transport,client,program,loader,natives,value_natives}.rs`, `crates/bunwasm-runtime/src/{engine,data,ops,split_api}.rs`) unchanged. |
| `crates/bunwasm-engine-hermes/src/vm.rs` | Port | This repository's own Hermes adapter from `hermes/engine-adapter` `7214ba50d` (`crates/bunwasm-runtime/src/engine_hermes.rs`), moved onto the current `Engine` trait. Changes: configuration through `bh_config` with the core's stack bounds; eval flags (optimize per `BUN_WASM_HERMES_OPT`, default none; lazy over 64 KiB); `promise_then` and the async context through the patch's private `Promise._T`/`_G`/`_S`, captured and deleted at startup; WebAssembly.Memory buffers as shim external buffers; typed arrays and DataViews convert to bytes; native-closure ids from GC finalizers go into reserved capacity, so the finalizer neither allocates nor runs JS; `memory_usage` reports Hermes's measured heap (`getHeapInfo`) with `rss`, `arrayBuffers` and `failedAllocation` `null` and the linear-memory capacity separately as `wasmCapacity`; fatal VM errors exit 134 with a message; a refusing `sbrk` (llvh's `GetMallocUsage` asks `sbrk(0)`) keeps the side from importing the core's break. Its `bunwasm-runtime` wiring and `engine-hermes` features are not carried over. No Hermes implementation is copied: it calls the shim's C API. |
| `crates/bunwasm-host/src/linked.rs`, `src/engine-kind.ts`, `scripts/src/engine-explicit-init.ts`, `scripts/guest-{core,engine,build}-receipt.ts`, `scripts/guest-source-manifest.ts`, `scripts/test.sh` | Host feature | The third paired kind `hermes`: section tag, companion `hermes-engine.wasm`, initializer and RUN names, receipt scope, and the `hermes-prebuild` input group (`$HERMES_BUILD_DIR/wasi/lib/libhermesvm_bunwasm.a` and its compile commands). Opt-in: nothing builds or registers it by default. |
| `scripts/build-engine-hermes.sh`, `scripts/build-bun-hermes.sh`, `scripts/hermes-import-delta.ts` | Host feature | The JSC build recipe without pointer spilling or `jsc/finalize.sh` (Hermes roots precisely), plus two checks: no exception tags in the side, and every `env`/`GOT` import is a core export or a side definition. |

## Interim limits

Until the record loader lands (design section 3), `eval_module` runs module-free `bun -e` code as a
script and `import_module` throws. The first proof scripts in `tests/hermes/` are `.cts`, because the
repository's `"type": "module"` makes syntax-free `.ts` files ES modules.
