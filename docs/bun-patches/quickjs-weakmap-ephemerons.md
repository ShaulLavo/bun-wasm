## QuickJS WeakMap entries as ephemerons

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. Upstream QuickJS-ng has the same marking at this revision.

A WeakMap entry must keep its value alive only while both the key and the map are reachable. The cycle collector marked the value as a child of the key alone (`mark_weak_map_value` from `mark_children`). When the value reaches its own map, a live key therefore kept the dead map, the value and everything they reach alive. Webpack does this on every compilation: each `ModuleGraph` has a `_dependencyMap` WeakMap keyed by dependencies that cached modules keep across compilations, and its `ModuleGraphConnection` values hold `condition` closures over that `ModuleGraph`. A Next.js dev server kept every old server compilation, about 7 MiB after a forced GC per edit/revert cycle, while Node kept only the latest. Five generations of the pattern in a plain script left 5 of 5 alive; V8 leaves 0.

The decref pass still attributes the entry's reference on the value to the key. The scan pass restores that reference, making the value live, only once both the key and the map are known to be live. Whichever of the two is scanned second does it, and `JSMapRecord.gc_restored` prevents a second restore. The restore pass returns the remaining references of entries whose key or map is dead, so `gc_free_cycles` and the map finalizer see consistent counts. `JSMapState.owner` points back to the map object for the liveness check. `map_add_record` starts `gc_restored` false, and object keys are checked before it is read. Outside the collector the marking is unchanged.

### Symbol keys

Symbols are not GC objects and die only by reference count, so the collector cannot tell whether a symbol key is live. Upstream never marked symbol-keyed values at all, so every such value counted as referenced from outside: a value that reaches its own map kept the dead map alive for the symbol's lifetime, the same retention as above. The collector now treats a symbol key as live and attributes its value to the map, like a `Map` value: the decref pass removes the reference through the map, and the scan or restore pass gives it back. The value therefore lives exactly as long as the map while the symbol does.

A symbol can still lose its last reference while the collector frees a cycle that held it. Its weak list then frees the record's value, which the scan found live because the map is live. Upstream ignores an object that reaches zero references during that phase, expecting every such object to be part of the cycle, so the value stayed in `gc_obj_list` until the next collection and `JS_FreeRuntime` failed `assert(list_empty(&rt->gc_obj_list))`. `js_free_value_rt` now moves an object that reaches zero references during that phase and that the scan found live (mark 0) onto the list being freed, so it is freed in the same collection. Objects already in the cycle keep mark 1 and are unaffected.

`weak_map_symbol_key_values_free_with_the_runtime` and `weak_map_symbol_key_values_follow_map_and_symbol` in `crates/bunwasm-engine-quickjs/src/vm.rs` fail the `JS_FreeRuntime` assertion without these changes. `tests/fixtures/weak-map-symbol-keys` checks the same reachability on every engine.

A differential fuzz of 2,000 random graphs of objects, WeakMaps and strong edges (27,466 objects) matched a reference ephemeron fixpoint and V8 exactly; the original marking differed on 117 objects. ASan and UBSan reported nothing.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, WeakMap marking in `gc_decref`/`gc_scan`](#quickjs-weakmap-entries-as-ephemerons) | Upstream bug | Keep a WeakMap value alive only while both its key and its map are alive. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, symbol-keyed values in `mark_weak_map_records`](#symbol-keys) | Upstream bug | Attribute a symbol-keyed WeakMap value to its map in the cycle collector. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, `js_free_value_rt`](#symbol-keys) | Upstream bug | Free an object the scan found live when its last reference drops while cycles are freed. |
| [`crates/bunwasm-engine-quickjs/src/vm.rs`, tests](#quickjs-weakmap-entries-as-ephemerons) | Upstream bug | Old graphs reached only through their own WeakMap are collected; the other ephemeron cases still hold; symbol-keyed values follow their map and symbol and free with the runtime. |
| [`tests/fixtures/weak-map-symbol-keys`](#symbol-keys) | Original adapter | Symbol-keyed values die with their map or symbol on every engine. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
