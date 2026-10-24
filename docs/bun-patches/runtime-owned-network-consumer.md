## Runtime-owned network consumer

`web/src/net/helper.ts`, `bun-launcher.ts`, `subprocess-broker.ts`, `runner.ts`,
`net/host.ts`, `bun-executor.ts`, the page entries and `src/bun-adapter.ts` are
original TypeScript adapters, not copied upstream implementations. They consume
Waffle's reviewed `fc58a532f0d7a617e631ea4b7580a190915d4ed6` contract. The caller's
Runtime owns one namespace. Each Bun process borrows a distinct ring and helper;
only physical worker cleanup releases that session and its module cache. Parent
exit and adapter uninstall leave admitted children alive. The existing installer
fetch cache remains the default policy; injected network fetch stays separate from
asset-download fetch. Preview1 receives no network session.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Runtime-owned network consumer](#runtime-owned-network-consumer) | Host feature | Original per-process session wiring over Waffle's borrowed runtime network, with physical-stop cleanup and shared preview observation. |

[Ledger scope and pinned revisions](scope.md).
