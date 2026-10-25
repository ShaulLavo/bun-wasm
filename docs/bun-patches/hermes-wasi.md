### Hermes for WASI

File `hermes/hermes-wasi.patch`, applied by `hermes/fetch-hermes.sh` to facebook/hermes at `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065` (2026-10-23, "Move isCachedUsingEpoch to HiddenClass (#1939)"). It starts from the direct wasi-sdk port proven in the Hermes spike (`/work/reports/bun-wasm-hermes-spike/direct-wasi.patch`, SHA-256 `a81910c0…`), without the spike's CLI-only changes (`tools/hermes`, `spike_syscalls.cpp`), plus the bun-wasm hunks marked below. Only the opt-in Hermes variant (`scripts/build-bun-hermes.sh`) builds it.

| Hermes file | Class | Change | What breaks without it |
| --- | --- | --- | --- |
| `CMakeLists.txt` | Port | Accept WASI for `HERMES_SANDBOX_WASM`, not only Emscripten. | Configure rejects the sandbox mode that compiles out shermes/JIT setjmp. |
| `external/llvh/cmake/config-ix.cmake` | Port | Turn LLVH threads off on WASI. | LLVH enables threading before its platform check. |
| `external/llvh/include/llvh/Demangle/Utility.h` | Upstream bug | Include `<exception>` and `<type_traits>` directly. | The old header relied on transitive libc++ includes that current libc++ dropped. |
| `external/llvh/lib/Support/Signals.cpp`, `Wasi/Signals.inc` (new) | Port | Original WASI signals adapter: runs registered callbacks, no OS signal delivery. | Unix `sigaction` and alternate stacks do not exist. |
| `external/llvh/lib/Support/Unix/{Host,Path,Process,Program,Unix.h,Watchdog}.inc` | Port | Guard `uname`, `passwd`, `statvfs`, `fork`/`exec`/`wait`, `alarm` and signal masks for WASI; unsupported calls return errors. | Missing POSIX APIs fail to compile. |
| `include/hermes/Support/SerialExecutor.h`, `lib/Support/SerialExecutor.cpp` | Port | Synchronous FIFO executor on single-thread wasm. Only the JSI API and the stack executor use it; bun-wasm's VM embedding has no finalizer thread. | Creating a worker thread fails. |
| `include/hermes/VM/JSLib/DateCache.h` | Port | Skip `tzset`. | WASI libc has no timezone database. |
| `include/hermes/VM/Profiler/SamplingProfilerDefs.h`, `lib/VM/Instrumentation/ProcessStats.cpp`, `lib/Support/OSCompatPosix.cpp` | Port | Sampling profiler and `/proc` statistics off on WASI. | Signal-driven sampling and Linux telemetry do not exist. |
| `lib/Support/OSCompatWasi.cpp` (new), `lib/Support/CMakeLists.txt` | Port | Adapted from `lib/Support/OSCompatEmscripten.cpp`: GC segments from zeroed `aligned_alloc`, no-op commit/uncommit, wasm-ld stack bounds, WASI pid and process clocks, explicit unsupported telemetry. | No OS adapter exists for WASI. |
| `include/hermes/VM/sh_runtime.h`, `include/hermes/VM/static_h.h` | Port | bun-wasm: without wasm exceptions, declare an inert `jmp_buf` instead of including `setjmp.h`. Sandbox builds never call setjmp or longjmp. | wasi-libc's `setjmp.h` refuses to compile without wasm exception handling; bun.wasm's libc++ is the no-exceptions build. |
| `include/hermes/VM/Runtime.h`, `lib/VM/Runtime.cpp` | Host feature | bun-wasm: enable the existing Emscripten host-timeout hooks (`test_wasm_host_timeout`) for WASI, and add `Runtime::hasPendingJobs()`. | `ModuleHost::interrupt` cannot stop a CPU-bound script; `Engine::run_jobs` cannot report whether it ran anything. |
| `lib/CMakeLists.txt` | Host feature | bun-wasm: the `hermesvm_bunwasm` static library, `hermesvm_a` without the JSI API (`hermesapi_obj`), plus the shim named by `BUNWASM_SHIM`, compiled with the VM's flags. | The JSI API needs C++ exceptions, which bun.wasm does not link. |

`hermes/wasi-hermes.cmake`, `hermes/build.sh` and `crates/bunwasm-hermes` are original bun-wasm build configuration and glue. `crates/bunwasm-hermes/cpp/shim.cpp` is an original adapter over `hermes::vm::Runtime`; its handle table follows the rooting pattern of `API/hermes_abi/hermes_vtable.cpp` (`ManagedValue` slots registered through `addCustomRootsFunction`), and its call, construct and host-function paths follow that file's `call`, `call_as_constructor` and `HostFunctionWrapper`. No code was copied verbatim. See [the Hermes engine notes](../hermes-engine.md).

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`hermes/hermes-wasi.patch`](#hermes-for-wasi) | Port | Compile the Hermes VM and compiler for WASI without exceptions or threads. |
| [`hermes/hermes-wasi.patch`, bun-wasm hunks](#hermes-for-wasi) | Host feature | Host interrupt hook, pending-jobs query and the JSI-free static library. |
| [`crates/bunwasm-hermes/cpp/shim.cpp`](#hermes-for-wasi) | Host feature | Original C interface to the VM; rooting modeled on `hermes_vtable.cpp`. |

[Ledger scope and pinned revisions](scope.md).
