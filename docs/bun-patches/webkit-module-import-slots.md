### WebKit module import slots

Files `Source/JavaScriptCore/runtime/JSModuleEnvironment.{h,cpp}` in `jsc/webkit-wasi.patch`. Class **Upstream bug**.

Allocate the module record, import count, and each import slot at a full variable-slot stride. Zero the whole import slot before clearing its pointer. Without this, pointer-sized slots on 32-bit targets overlap when addressed through `importSlotScopeOffset` as JSValue-sized variables. An import can resolve to another imported module's binding. Clearing only the pointer also leaves the rest of a JSValue load uninitialized.

The mismatch concerns pointer width and slot addressing, not a missing WASI API. That is why this is an upstream bug. The installed native Bun 1.4.2 uses 64-bit pointers and passes `tests/fixtures/engine-esm-imports`; it cannot exercise the width mismatch. A native 32-bit WebKit build has not been run. The same slot-size relationship makes that configuration suspect, but this ledger does not claim a native 32-bit reproduction. The ready-to-file report in the owner's upstream list records that limit.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, module slots](#webkit-module-import-slots) | Upstream bug | Give import slots a full JSValue stride and initialize the whole slot. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
