### Host GC hook

Class **Host feature**. Original host adapter. Capture an exposed host collector before
installing guest globals. Bun's `test/harness.ts` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` replaces global `gc` with a call to `Bun.gc`;
looking up that guest wrapper from the host hook recurses. Hosts without an exposed collector
still cannot force collection. No upstream implementation is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`web/src/engine-host.js`, GC hook](#host-gc-hook) | Host feature | Capture host GC before guest code replaces globals. Original adapter. |

[Parent context](bun-patch-series.md).
