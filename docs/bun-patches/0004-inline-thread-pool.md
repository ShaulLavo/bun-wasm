### 0004 inline thread pool

File `0004-wasm-thread-pool-runs-scheduled-tasks-inline-on-sing.patch`. Class **Port**.

`src/threading/ThreadPool.rs` drains its task queue inline on wasm without atomics. Nested schedules on the same pool are handled by the outer drain loop, and `warm` starts no workers. Without it the bundler tries to spawn unsupported threads and cannot complete its parse work. Native thread scheduling is unchanged.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0004](#0004-inline-thread-pool) | Port | Drain scheduled tasks on the calling thread. |

[Parent context](bun-patch-series.md).
