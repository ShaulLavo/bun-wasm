### Host GC hook

Class **Host feature**. Original host adapter. Capture an exposed host collector before
installing guest globals. Bun's `test/harness.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` replaces global `gc` with a call to `Bun.gc`;
looking up that guest wrapper from the host hook recurses.

Under the Node headless host (`web/scripts/node-host.ts`), tight `MessageChannel` turns can
starve Node/V8 `FinalizationRegistry` cleanup callbacks while `setImmediate` loops call
`Bun.gc(true)`. `EngineHostOptions.yieldAfterGc` opts only that host into a one-shot
`setTimeout(..., 0)` yield after an explicit `gc()` call (including when a `MessageChannel`
turn was already posted). In addition, calling `WeakRef.prototype.deref()` pins targets in
V8's `KeepDuringJob` set for the rest of the current turn, so a synchronous `Bun.gc(true)`
in that same turn promotes those targets to old space instead of collecting them; when a host
collector is available, `EngineHost.schedulePostTurnGc` schedules one deduplicated, unref'd
`setTimeout(..., 0)` follow-up collection (cancelled on exit) from the root async context
(`EngineHostOptions.asyncContext.runRoot`, backed by `AsyncLocalStorage.snapshot()` in
`web/scripts/async-context.ts`) so the timer cannot retain an active guest `AsyncLocalStorage`
store and runs collection in a later turn once `KeepDuringJob` clears.
`EngineHostOptions.gc` lets the Node host pass a collector exposed
under a private V8 startup flag (`--expose-gc-as=__bunwasm_v8_gc` in `scripts/bun-suite.py`),
leaving `globalThis.gc` configurable for Bun's `test/harness.ts` while fixture runs opt into
`--expose-gc` via their `expose-gc` marker in `scripts/test.sh`. Product hosts leave `gc` and
`yieldAfterGc` unset and keep their existing scheduling unchanged. No upstream implementation
is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/engine-host.js`, GC hook](#host-gc-hook) | Host feature | Capture host GC before guest code replaces globals; optional `gc` hook, `yieldAfterGc` one-shot timeout yield, and root-context deduplicated unref'd post-turn follow-up collection for `KeepDuringJob`-pinned `WeakRef` targets. Original adapter. |
| [`web/scripts/node-host.ts`, `web/scripts/async-context.ts`, `scripts/bun-suite.py`](#host-gc-hook) | Host feature | Forward `--expose-gc-as=__bunwasm_v8_gc` collector, `yieldAfterGc: true`, and `AsyncLocalStorage.snapshot()` `runRoot` from the Node fixture host; pass `--expose-gc-as=__bunwasm_v8_gc` at Node startup in `bun-suite.py`. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
