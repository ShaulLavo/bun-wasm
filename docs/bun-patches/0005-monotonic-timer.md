### 0005 monotonic timer

File `0005-wasm-Instant-backed-system-timer-on-wasi.patch`. Class **Port**.

`src/perf/system_timer.rs` selects the existing `Instant` implementation for WASI, leaving the timer stub for bare wasm. Without it the resolver's timer reset takes the unsupported stub path. WASI supplies a monotonic clock, while bare wasm does not require one. Native Bun already uses `Instant`.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0005](#0005-monotonic-timer) | Port | Use WASI's monotonic clock instead of the bare-wasm timer stub. |

[Parent context](bun-patch-series.md).
