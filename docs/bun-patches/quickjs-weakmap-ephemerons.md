## QuickJS WeakMap entries as ephemerons

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. Upstream QuickJS-ng has the same marking at this revision.

A WeakMap entry must keep its value alive only while both the key and the map are reachable. The cycle collector marked the value as a child of the key alone (`mark_weak_map_value` from `mark_children`). When the value reaches its own map, a live key therefore kept the dead map, the value and everything they reach alive. Webpack does this on every compilation: each `ModuleGraph` has a `_dependencyMap` WeakMap keyed by dependencies that cached modules keep across compilations, and its `ModuleGraphConnection` values hold `condition` closures over that `ModuleGraph`. A Next.js dev server kept every old server compilation, about 7 MiB after a forced GC per edit/revert cycle, while Node kept only the latest. Five generations of the pattern in a plain script left 5 of 5 alive; V8 leaves 0.

The decref pass still attributes the entry's reference on the value to the key. The scan pass restores that reference, making the value live, only once both the key and the map are known to be live. Whichever of the two is scanned second does it, and `JSMapRecord.gc_restored` prevents a second restore. The restore pass returns the remaining references of entries whose key or map is dead, so `gc_free_cycles` and the map finalizer see consistent counts. `JSMapState.owner` points back to the map object for the liveness check. Symbol keys are not GC objects; their values are untouched, as before. Outside the collector the marking is unchanged.

A differential fuzz of 2,000 random graphs of objects, WeakMaps and strong edges (27,466 objects) matched a reference ephemeron fixpoint and V8 exactly; the original marking differed on 117 objects. ASan and UBSan reported nothing.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, WeakMap marking in `gc_decref`/`gc_scan`](#quickjs-weakmap-entries-as-ephemerons) | Upstream bug | Keep a WeakMap value alive only while both its key and its map are alive. |
| [`crates/bunwasm-engine-quickjs/src/vm.rs`, tests](#quickjs-weakmap-entries-as-ephemerons) | Upstream bug | Old graphs reached only through their own WeakMap are collected; the other ephemeron cases still hold. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
