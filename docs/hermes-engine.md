# Hermes VM library (opt-in)

Meta's Hermes VM built for `wasm32-wasip1` as a static library, with a small C interface for embedding it. It is a candidate fourth engine next to QuickJS, JavaScriptCore and the host engine. Nothing in bun.wasm links it yet, and default builds and default CI never compile it.

## Build and smoke test

```sh
scripts/build-hermes.sh   # ${HERMES_BUILD_DIR:-/work/tmp/bun-wasm-hermes}/wasi/lib/libhermesvm_bunwasm.a
hermes/smoke.sh           # crates/bunwasm-hermes/examples/smoke.rs under wasmtime
```

`hermes/build.sh` builds a host `hermesc` first (the wasm build compiles Hermes's internal JavaScript with it), then the VM with wasi-sdk and Waffle's patched sysroot. The source is facebook/hermes pinned in `hermes/common.sh`, patched by `hermes/hermes-wasi.patch` ([provenance](bun-patches/hermes-wasi.md)). The smoke test creates a runtime, evaluates scripts and reads back numbers and strings, calls a native function, drains promise jobs, catches thrown and syntax errors, and keeps a value alive across a forced GC.

## Layout

```
hermes/                              fetch, patch, toolchain, build and smoke scripts
crates/bunwasm-hermes/cpp/shim.cpp   C interface over hermes::vm::Runtime, compiled into the library
crates/bunwasm-hermes/src/lib.rs     the shim's declarations for Rust
crates/bunwasm-hermes/examples/      the smoke test
```

## Embedding API

The shim is our own C interface over the VM, not Hermes's JSI or its C ABI (`API/hermes_abi`):

- JSI reports errors by throwing C++ exceptions and needs RTTI. bun.wasm links one libc++, the no-exceptions build in the patched sysroot. The VM itself builds with `-fno-exceptions -fno-rtti`, so the patch adds `hermesvm_bunwasm`, the VM library without the JSI API, plus the shim.
- `hermes_abi` is exception-free but shaped like JSI: it has nothing for promise state, proxies, ArrayBuffer detaching, error checks or rejection tracking, so it would need a second layer over the VM anyway.

Values cross as `u32` handles into a slot table the VM scans as GC roots (the `addCustomRootsFunction` pattern of `hermes_vtable.cpp`); each handle owns one reference (`bh_dup`, `bh_release`). Native functions are `FinalizableNativeFunction`s whose context is an embedder id; the shim calls the embedder's `bunhermes_host_call`, `bunhermes_host_drop` (function collected) and `bunhermes_host_interrupt` (cancellation poll at async-break checks).

## Limits

- No `Intl` (`HERMES_ENABLE_INTL=OFF`), no lexical direct `eval`, no ES modules or top-level `await` in the VM.
- The GC heap cap is the embedder's choice (`bh_init`); bun.wasm's linear memory stays under 512 MiB.
