### Host GC hook

Class **Host feature**. Original host adapter. Capture an exposed host collector before
installing guest globals. Bun's `test/harness.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` replaces global `gc` with a call to `Bun.gc`;
looking up that guest wrapper from the host hook recurses. `EngineHostOptions.gc` lets hosts
supply a collector explicitly when `globalThis.gc` is not exposed at startup: the headless Node
fixture host (`web/scripts/node-host.ts`) enables V8's `--expose_gc` via `node:v8` and passes the
collector through `startEngineHost({ gc })` so `Bun.gc()` and `bun:jsc` GC hooks force real V8
collections on the Browser engine. After an explicit GC call, `EngineHost.schedule(0)` yields
once through `setTimeout(..., 0)` instead of `MessageChannel` so Node/V8 runs pending
`FinalizationRegistry` cleanup callbacks before the next `setImmediate` turn. Hosts without an
exposed collector still cannot force collection. No upstream implementation is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/engine-host.js`, GC hook](#host-gc-hook) | Host feature | Capture host GC (or `options.gc`) before guest code replaces globals. Original adapter. |
| [`web/scripts/node-host.ts`](#host-gc-hook) | Host feature | Expose V8's `gc()` through `EngineHostOptions.gc` in the Node Browser host. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
