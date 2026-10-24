## Module preparation benchmark host

Class **Host feature**, **original adapter** in `scripts/bench-module-preparation.ts` (the
existing `.mjs` command is a TypeScript-entry shim). It uses the same `NodeProcessBroker`
and `createNodeProcess` adapters as the headless host: the controller remains responsive
on the main thread while the measured guest runs in a worker with real `runtime_proc`
imports and preview1 descriptor routing. The benchmark loads `wasmCaller` from the existing
`web/src/engine-host.js` through the original source wrapper, resolving its local imports
to file URLs. It keeps the plain-JS, await and TypeScript fixtures, fresh-path and cached-call
measurements; success, errors, interruption and a bounded deadline all stop the owned worker
and remove its fixtures. No Bun, Node, wasi-libc or third-party implementation is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Module preparation benchmark host](#module-preparation-benchmark-host) | Host feature | Original Node benchmark harness runs the actual guest in a worker with the shared process broker and descriptor ABI, preserving responsive synchronous process calls. |

[Ledger scope and pinned revisions](scope.md).
