# Hermes engine (opt-in)

`dist/bun-hermes.wasm` is bun-wasm with Meta's Hermes VM as its JavaScript engine, next to QuickJS (default), JavaScriptCore (`engine-jsc`) and the host engine (`engine-host`). It is experimental. Default builds and default CI never compile Hermes.

## Build

```sh
scripts/build-hermes.sh       # Hermes VM -> ${HERMES_BUILD_DIR:-/work/tmp/bun-wasm-hermes}/wasi/lib/libhermesvm_bunwasm.a
scripts/build-bun-hermes.sh   # dist/bun-hermes.wasm (cargo feature engine-hermes)
target/release/bun-wasm --wasm dist/bun-hermes.wasm --dir .::/ --env PWD=/ -- -e 'console.log(1 + 1)'
```

`hermes/build.sh` builds a host `hermesc` first (the wasm build compiles Hermes's internal JavaScript with it), then the VM for `wasm32-wasip1` with wasi-sdk and Waffle's patched sysroot. The source is facebook/hermes pinned in `hermes/common.sh`, patched by `hermes/hermes-wasi.patch` ([provenance](bun-patches/hermes-wasi.md)).

## How it embeds

```
crates/bunwasm-runtime/src/engine_hermes.rs   Engine trait over the shim (Rust)
crates/bunwasm-hermes/src/lib.rs              the shim's C declarations
crates/bunwasm-hermes/cpp/shim.cpp            C interface over hermes::vm::Runtime
hermes/                                       fetch, patch, toolchain and build of the VM
```

The shim is our own C interface over the VM, not Hermes's JSI or its C ABI (`API/hermes_abi`):

- JSI reports errors by throwing C++ exceptions and needs RTTI. bun.wasm links one libc++, the no-exceptions build in the patched sysroot. The VM itself builds with `-fno-exceptions -fno-rtti`, so the patch adds `hermesvm_bunwasm`, the VM library without the JSI API.
- `hermes_abi` is exception-free but shaped like JSI: it has nothing for promise state, proxies, ArrayBuffer detaching, error checks or rejection tracking. bun-wasm would need a second layer over the VM for those anyway.

Values cross as `u32` handles into a slot table the VM scans as GC roots (the `addCustomRootsFunction` pattern `hermes_vtable.cpp` uses). `HVal` owns one reference: `Clone` adds one, `Drop` releases it. Native functions are `FinalizableNativeFunction`s whose context is an id into the runtime's closure table; a collected function's closure is dropped at the next job drain, outside the GC.

Hermes's `Promise` is its JavaScript implementation (`lib/InternalJavaScript/01-Promise.js`). The engine reads its state fields (`_y`, `_z`) for `promise_state`/`promise_result`, and installs the static hooks it calls on rejection and on attaching a handler (`Promise._C`, `Promise._B`) to track unhandled rejections.

## ES modules

Hermes runs classic scripts only: no `import`/`export`, top-level `await`, `import()` or `import.meta`. ES modules go through a module loader written for the runtime (the Hermes ESM loader) that runs each module as a script. The engine's side of that contract:

- The loader is an object at the non-enumerable global `__bunwasmEsmLoader` with `importModule(specifier, referrer)` and `evalModule(name, source)`, both returning promises. `Engine::import_module` and `Engine::eval_module` call them.
- The loader uses `eval_script`, plain generators and the job queue, all of which work as on the other engines.
- Until a loader is installed, `eval_module` runs module-free code (`bun -e 'console.log(1)'`) as a script and `import_module` throws.

## Engine mapping

| Engine method | Hermes |
| --- | --- |
| values, objects, properties, `keys`, `error_value` | Done. `keys` calls `Object.keys`; non-enumerable `name` uses `Object.defineProperty`. |
| `new_function`, `call` | Done (`FinalizableNativeFunction`, `ScopedNativeCallFrame`). |
| `eval_script` | Done. Hermes has no line offset: header lines before line 1 (the CommonJS wrapper) are folded onto line 1. |
| `import_module`, `eval_module` | Seam for the ESM loader (above). |
| `run_jobs` | Done: `Runtime::drainJobs`, WeakRef kept-objects and FinalizationRegistry cleanup. |
| `promise_state`, `promise_result`, `promise_then`, `is_promise` | Done over the JS Promise's fields and the original `Promise.prototype.then`. |
| `take_unhandled_rejections` | Done (`Promise._C`/`_B`). |
| `is_proxy`, `proxy_target`, `is_error`, `is_detachable_buffer`, `detach_buffer`, `same_value` | Done (VM type checks). |
| `iterator_entries`, `own_keys_in_order` | Not provided (optional). |
| `async_context`, `set_async_context` | Stored, but not carried across `await`: AsyncLocalStorage loses its value after an await. |
| `gc`, `memory_usage` | Done (`Runtime::collect`, GC heap info). |
| `ModuleHost::interrupt` | Polled every 10,000 async-break checks when the host has an interrupt handler (compiled-in checks; uncatchable timeout error). |

## Limits

- No `Intl` (built with `HERMES_ENABLE_INTL=OFF`); no lexical direct `eval`.
- GC heap capped at 256 MiB (`BUN_WASM_HERMES_HEAP_MIB`, at most 448), under bun.wasm's 512 MiB linear memory.
