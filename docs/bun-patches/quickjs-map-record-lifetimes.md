## QuickJS map records freed under their loops

Class **Upstream bug**. This changes `quickjs/quickjs.c` from the QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/quickjs.c`. Both changes are ports of later upstream QuickJS-ng commits.

`js_map_finalizer` walked a WeakMap's records and, for each one, removed its weak reference and then freed its value. When that value held the last reference to the key of a later record, freeing it ran `reset_weak_ref` on that key, which unlinked and freed the later record. The loop had already cached it as the next element, so it read freed memory: an assertion in `delete_map_weak_ref`, a crash, or a heap-use-after-free under AddressSanitizer. The finalizer now removes every weak reference first and frees the values in a second pass, as `reset_weak_ref` does. This is upstream commit `25a005b4c5e51bd8b517c77c1abe053f81d086ce` ("Fix UAF when freeing WeakMap with symbol values", quickjs-ng#1844), which covers object keys as well as symbol keys.

`js_map_clear` cached the next record with `list_for_each_safe`. Deleting a record frees its key and value, and that can free a deleted record that only a map iterator was keeping, when the value held that iterator. `Map.prototype.clear` and `Set.prototype.clear` now hold a reference on the current record and read its successor after deleting it, like `forEach`. This is upstream commit `b15a5f1acd0a1ae83ac79c8fd0315402b2cf21f2` ("Fix use-after-free in Map.prototype.clear and Set.prototype.clear", quickjs-ng#1907).

`weak_map_finalizer_survives_values_that_free_later_keys` and `map_clear_survives_records_freed_by_deleted_values` in `crates/bunwasm-engine-quickjs/src/vm.rs` abort or crash without these changes. `tests/fixtures/weak-map-symbol-keys` runs both patterns on the guest; the QuickJS guest without them aborts.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, `js_map_finalizer`](#quickjs-map-records-freed-under-their-loops) | Upstream bug | Detach every WeakMap record before freeing any value (upstream `25a005b4c5`). |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, `js_map_clear`](#quickjs-map-records-freed-under-their-loops) | Upstream bug | Hold the current record while deleting it (upstream `b15a5f1acd`). |
| [`crates/bunwasm-engine-quickjs/src/vm.rs`, tests; `tests/fixtures/weak-map-symbol-keys`](#quickjs-map-records-freed-under-their-loops) | Original adapter | Free maps whose values own later keys or pinned records. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
