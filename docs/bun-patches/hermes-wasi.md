# Hermes VM for WASI

| Local source | Class | Upstream source and revision |
| --- | --- | --- |
| `hermes/hermes-wasi.patch` | Port | facebook/hermes `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065`, paths below |
| Runtime timeout hooks, `hasPendingJobs`, `hermesvm_bunwasm` target | Host feature | `include/hermes/VM/Runtime.h`, `lib/VM/Runtime.cpp`, `lib/CMakeLists.txt`, same pin |
| `cpp/shim.cpp` in `crates/bunwasm-hermes` | Original adapter | `API/hermes_abi/hermes_vtable.cpp` rooting and call patterns at the same pin; no verbatim copy |
| `hermes/*.sh`, `wasi-hermes.cmake`, sys crate and smoke | Original build glue | Retained bun-wasm `d7c6149b210b59f9229d4b8018102ba958e6f6ce`, PR #231 |

This ports the retained VM-only work to a PIC static library for an engine side module. No runtime adapter, default engine selection, default CI build, or common-core code changes are included.

The upstream patch covers WASI's missing process and signal APIs in llvh `Support/Unix` and `Support/Wasi`, single-threaded `SerialExecutor`, timezone reset, profiler availability, the no-EH `setjmp.h` guard, runtime timeout hooks, pending-jobs query, and a JSI-free library target. `OSCompatWasi.cpp` adapts `OSCompatPosix.cpp` at the pin. It obtains and frees pages through `aligned_alloc` and `free`; it cannot protect linear-memory pages. It never grows memory or calls `sbrk`, `mmap`, `munmap`, or `mprotect`. llvh's file mapping returns unsupported on WASI so `MemoryBuffer` uses its existing file-read fallback. The mmap declaration define is still needed to compile unused llvh support code; no mmap emulation library is linked.

Stack bounds arrive in `bh_init` configuration before Runtime creation. The shim's stack-bound helpers feed `thread_stack_bounds_impl`, and Hermes preserves its default 64 KiB guard gap. Fatal errors from Hermes flow through llvh's installed handler to the embedder's `bunhermes_host_fatal`. The embedder must print the message and terminate with exit 134. JS exceptions remain fallible C results. Interrupt polling invokes a non-JS callback every 10,000 checks. GC finalizers call only the embedder's queue-only drop callback. FinalizationRegistry callbacks run during `bh_drain_jobs`.

The shim keeps rooted reference-counted handles from #231. New APIs add configured heap and stack bounds, explicit eval flags, all typed-array and DataView byte ranges, heap external-byte accounting, and external buffers whose no-op deleter preserves embedder-owned Wasm memory. Detach invalidates views without freeing that memory.

Build with `source env.sh; HERMES_BUILD_DIR=<private-tree> hermes/build.sh`. All VM C++ objects use `-fPIC -fno-exceptions -fno-rtti`; HV32, 1 MiB segments and native stack checks are enabled. The sys crate links the patched sysroot's `noeh` C++ libraries and process clocks only. Host-target builds link no Hermes library. The optional `standalone` feature exists only for the VM-only smoke and links signal/getpid emulation and the WASI command startup object.

See [Promise context changes](hermes-async-context.md) and `hermes/smoke.sh` for the VM-only gate. This classified record is additive; the frozen overview file is unchanged for the coordinated wave.
