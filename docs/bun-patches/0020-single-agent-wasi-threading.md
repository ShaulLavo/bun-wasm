### 0020 single-agent WASI threading

File `0020-wasm-WASI-guests-are-single-agents-even-with-atomics.patch`. Class **Port**. Upstream source is Bun `src/threading/Futex.rs` and `src/threading/ThreadPool.rs` at `9510e74152073d850a18758ca41114d8f214ffa6`, after patches 0002, 0004 and 0013, which chose the single-thread futex and the inline pool when `atomics` is absent.

A shared-group program (the opt-in [memory-group profile](shared-group-program-profile.md)) builds every guest object with wasm atomics so its members can share one memory. Each member is still one agent with no threads. With `atomics` alone as the test, such a member compiled upstream's threaded wasm futex. Its `core::arch::wasm32::memory_atomic_wait32`/`memory_atomic_notify` calls are the unstable library feature `stdarch_wasm_atomic_wait`, so the pinned nightly refused the crate (E0658). Its pool would also have tried to spawn threads that do not exist and left queued tasks unrun.

This patch selects the single-agent futex and the inline pool on every WASI guest: `all(target_arch = "wasm32", any(target_os = "wasi", not(target_feature = "atomics")))`. Upstream's threaded wasm futex stays for wasm32 targets with atomics outside WASI. Native builds and atomics-free WASI builds evaluate every predicate exactly as before. No crate feature attribute, `RUSTC_BOOTSTRAP` or global flag is added.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0020](#0020-single-agent-wasi-threading) | Port | Treat every WASI guest as one agent in Bun's futex and thread pool. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
