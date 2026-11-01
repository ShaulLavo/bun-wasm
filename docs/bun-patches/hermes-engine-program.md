# Hermes engine program

Source integration record for the third linked engine program, `hermes-engine.wasm`, on
bun-wasm `404a956ffdf3fbee9c94b4875be0afe3fbe09df5`. The Hermes VM, its patch and the C shim
are recorded separately ([Hermes on WASI](hermes-wasi.md),
[async context](hermes-async-context.md)). Design: `docs/hermes-engine.md`.

## Classification

| Source | Class | Origin and change |
| --- | --- | --- |
| `crates/bunwasm-engine-hermes/src/lib.rs`, `Cargo.toml` | Port | Original registration and entry adapter, the JSC side's `lib.rs` with `hermes_` names. It compiles the shared program sources (`crates/bunwasm-engine-quickjs/src/{driver,allocator,transport,client,program,loader,natives,value_natives}.rs`, `crates/bunwasm-runtime/src/{engine,data,ops,split_api}.rs`) unchanged. |
| `crates/bunwasm-engine-quickjs/src/side_modules.rs`, `crates/bunwasm-engine-jsc/src/lib.rs` | Port | The JSC side's module list and allocator, moved into one file that the JSC and Hermes sides both `include!`. No behavior change for JSC. |
| `scripts/quickjs-core-exports.txt`, `crates/bunwasm-cli/build.rs` | Port | The common core exports `clock getrusage getpagesize isatty lseek pthread_create pthread_join isalpha isprint modf` and links wasi-libc's process-clock emulation, because sides cannot link libc members (the sysroot archives are not PIC: absolute `R_WASM_MEMORY_ADDR_*` relocations against `errno`). Measured from the Hermes side's imports with `scripts/side-import-delta.ts`. |
| `crates/bunwasm-engine-hermes/src/vm.rs` | Port | This repository's own Hermes adapter from `hermes/engine-adapter` `7214ba50d` (`crates/bunwasm-runtime/src/engine_hermes.rs`), moved onto the current `Engine` trait. Changes: configuration through `bh_config` with the core's stack bounds; eval flags (optimize per `BUN_WASM_HERMES_OPT`, default none; lazy over 64 KiB); `promise_then` and the async context through the patch's private `Promise._T`/`_G`/`_S`, captured and deleted at startup; WebAssembly.Memory buffers as shim external buffers; typed arrays and DataViews convert to bytes; native-closure ids from GC finalizers go into reserved capacity, so the finalizer neither allocates nor runs JS; `memory_usage` reports Hermes's measured heap (`getHeapInfo`) with `rss`, `arrayBuffers` and `failedAllocation` `null` and the linear-memory capacity separately as `wasmCapacity`; fatal VM errors exit 134 with a message; a refusing `sbrk` (llvh's `GetMallocUsage` asks `sbrk(0)`) keeps the side from importing the core's break. Its `bunwasm-runtime` wiring and `engine-hermes` features are not carried over. No Hermes implementation is copied: it calls the shim's C API. |
| `crates/bunwasm-host/src/linked.rs`, `src/engine-kind.ts`, `scripts/src/engine-explicit-init.ts`, `scripts/guest-{core,engine,build}-receipt.ts`, `scripts/guest-source-manifest.ts`, `scripts/test.sh` | Host feature | The third paired kind `hermes`: section tag, companion `hermes-engine.wasm`, initializer and RUN names, receipt scope, and the `hermes-prebuild` input group (`$HERMES_BUILD_DIR/wasi/lib/libhermesvm_bunwasm.a` and its compile commands). Opt-in: nothing builds or registers it by default. |
| `scripts/build-engine-hermes.sh`, `scripts/build-bun-hermes.sh`, `scripts/side-import-delta.ts` | Host feature | The JSC build recipe without pointer spilling or `jsc/finalize.sh` (Hermes roots precisely), plus two checks: no exception tags in the side, and every `env`/`GOT` import is a core export or a side definition. |

## Registration modules

The original Hermes adapter now consumes the shared registration loader through
`ModuleHost::record_loader_source`, `load_record`, and `lower_script`. Native
`resolve`, `load`, and `initMeta` functions pass resolved names and rooted values
without the wrapper-module handoff. A process-rooted loader serves `importModule`
and `importName`, including virtual eval sources, live bindings, and top-level await.
The core still owns parsing and source maps. User scripts lower dynamic imports
through the core and receive Hermes's `"show source"` directive on their first line,
unless `BUN_WASM_HERMES_SHOW_SOURCE=0`. No upstream implementation is added here.

`tests/hermes/pair.ts` and `proof.ts` are original proof adapters. The pair
composer verifies separate origin receipts and the exact shared module source
contract. The runner uses the original J1 module source fixtures through the real
host loader and selects existing discovered native checks. New TypeScript fixtures
cover imported top-level await, module-cache and rejection identity, script dynamic
imports, metadata, AsyncLocalStorage, source error lines, and memory semantics.
The CPU-interrupt fixture adapts this repository's J3 guest-child probe and adds
explicit child cleanup. It compares the same guest signal path on QuickJS and
Hermes; it does not test native launcher OS-signal forwarding.
