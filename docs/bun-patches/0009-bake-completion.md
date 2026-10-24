### 0009 bake completion

File `0009-Drive-bake-completion-from-the-WASI-mini-event-loop.patch`. Class **Port**.

`src/bundler/bundle_v2.rs` exposes `finish_wasi_dev_server` to wait for parsing and call the existing bake completion path. Without it bun-wasm's synchronous mini event loop cannot drive the native asynchronous completion task, so dev-server bundles cannot finish through that path. Native bake already schedules its completion.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0009](#0009-bake-completion) | Port | Complete bake bundles through the synchronous WASI event loop. |

[Parent context](bun-patch-series.md).
