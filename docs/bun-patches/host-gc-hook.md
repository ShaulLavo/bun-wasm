### Host GC hook

Class **Host feature**. Original host adapter. Capture an exposed host collector before
installing guest globals. Bun's `test/harness.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` replaces global `gc` with a call to `Bun.gc`;
looking up that guest wrapper from the host hook recurses.

Under the Node headless host (`web/scripts/node-host.ts`), tight `MessageChannel` turns can
starve Node/V8 `FinalizationRegistry` cleanup callbacks while `setImmediate` loops call
`Bun.gc(true)`. `EngineHostOptions.yieldAfterGc` opts only that host into a one-shot
`setTimeout(..., 0)` yield after an explicit `gc()` call (including when a `MessageChannel`
turn was already posted). `EngineHostOptions.gc` lets the Node host pass a collector exposed
under a private V8 startup flag (`--expose-gc-as=__bunwasm_v8_gc` in `scripts/bun-suite.py`),
leaving `globalThis.gc` configurable for Bun's `test/harness.ts` while fixture runs opt into
`--expose-gc` via their `expose-gc` marker in `scripts/test.sh`. Product hosts leave `gc` and
`yieldAfterGc` unset and keep their existing scheduling unchanged. No upstream implementation
is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/engine-host.js`, GC hook](#host-gc-hook) | Host feature | Capture host GC before guest code replaces globals; optional `gc` hook and `yieldAfterGc` one-shot timeout yield. Original adapter. |
| [`web/scripts/node-host.ts`, `scripts/bun-suite.py`](#host-gc-hook) | Host feature | Forward `--expose-gc-as=__bunwasm_v8_gc` collector and `yieldAfterGc: true` from the Node fixture host; pass `--expose-gc-as=__bunwasm_v8_gc` at Node startup in `bun-suite.py`. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
