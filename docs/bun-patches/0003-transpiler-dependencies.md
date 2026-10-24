### 0003 transpiler dependencies

File `0003-wasm-io-waker-crash-handler-resolver-bun_transpiler-.patch`. Class **Port**.

Add WASI CPU-feature reporting, crash-handler branches, an inert I/O waker, WASI resolver stat hashing, and platform selection for the mini event loop. Without it the transpiler's dependency graph cannot type-check for WASI or references native platform machinery. WASI has neither native CPUID nor Bun's native wake mechanism.

Files touched, relative to `vendor/bun/`:

- `src/crash_handler/CPUFeatures.rs`
- `src/crash_handler/lib.rs`
- `src/io/lib.rs`
- `src/resolver/fs/stat_hash.rs`
- `src/resolver/lib.rs`


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0003](#0003-transpiler-dependencies) | Port | Supply WASI wakers, CPU features, crash, and resolver implementations. |

[Parent context](bun-patch-series.md).
