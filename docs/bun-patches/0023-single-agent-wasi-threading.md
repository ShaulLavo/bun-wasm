# Single-agent WASI threading with shared memory

Classification: Port. Upstream `oven-sh/bun` at `9510e74152073d850a18758ca41114d8f214ffa6`,
paths `src/threading/Futex.rs` and `src/threading/ThreadPool.rs` after patch 0004.
The adaptation is reused from bun-wasm commit
`cc4f66eed1a0fb107e5c6aa4175248ab90cefa4f`, now exported as patch 0023.

A WASI memory-group member has one executing agent. Compiling it with atomics
does not create native threads inside that member. Select Bun's existing
single-agent futex and inline task-pool implementations on WASI, including when
its linear memory is shared. The ordinary transpiler-enabled group core otherwise
fails on unstable threaded wasm wait intrinsics and selects a task pool whose
threads cannot start. Native targets and non-WASI threaded wasm retain their
original implementation. Actual nested Wasm and QuickJS JS atomics are unrelated
to this scheduler and remain real atomic instructions with one host wait provider.

The vendor change is a commit on its local `wasm` branch. The patch exporter ran;
unrelated patch header and filename churn was discarded. No loader or module-record
patch changed.
