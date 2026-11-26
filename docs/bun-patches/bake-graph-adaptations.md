### Bake graph adaptations

`crates/bunwasm-build/src/dev_server/facade.rs`, `crates/bunwasm-build/src/dev_server/graph.rs`, and `crates/bunwasm-build/src/dev_server/finalize.rs`. Class **Port**. Upstream `src/runtime/bake/dev_server/{mod,finalize,trace,router_glue,source_map_store}.rs` at the Bun pin. Bun 1.4.5 split the former `src/runtime/bake/DevServer.rs` into those modules.

The facade retains graph context and result structures, trace-bit handling, and CSS accumulation. The graph owner adapts bundle extraction, source-map entry shapes, route indices, and the HMR runtime accessor. Finalization translates the host-independent part of `DevServer::finalize_bundle`, including receiving emitted JS/CSS/HTML and updating import edges. These are adapted implementations, not merely original wrappers around unchanged graph modules.

Replace the native server's locks, watchers, route machinery, and scheduling with single-thread state, host notifications, and synchronous output. Keep the frontend bundling path without native server-component execution. `dev_server/mod.rs` and `hooks.rs` wire this state into BundleV2. `cache.rs` adds bun-wasm's dependency-cache format. Those host adapters and the cache implementation are original code.

The incremental graph, packed map, and serialized-failure implementations are compiled directly through `#[path]` from `src/runtime/bake/dev_server/{incremental_graph,packed_map,serialized_failure}.rs`. They are unchanged upstream modules, not additional copied forks.

At Bun 1.4.5 the included graph asks more of its owner, and the facade follows: the context types live at `bake::dev_server`, `GraphTraceState` has a `failures` list that a `FindErrors` trace fills (this server never requests one), `InsertFailureKey::AbsPath` carries the graph the failed task was queued for (always `Client` here), and `router_glue::ClientPageFiles` is the shape of a framework route's client pages, which this server never has. `bake_types::Framework::new` takes the routers' client page folders, an empty list here. Upstream's `finalize_bundle` also began reporting a file whose code or CSS failed to print as a bundling failure; `finalize.rs` does not port that yet and handles those results as before.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-build/src/dev_server/facade.rs`, `crates/bunwasm-build/src/dev_server/graph.rs`, `crates/bunwasm-build/src/dev_server/finalize.rs`](#bake-graph-adaptations) | Port | Adapt bake's graph owner, context types, and bundle finalization to synchronous WASI. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
