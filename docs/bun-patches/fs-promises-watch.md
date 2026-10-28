# Promise filesystem watcher

Class **Host feature**, **original adapter** in
`crates/bunwasm-runtime/src/js/fs_promises_watch.ts`, wired lazily by `node_fs.js`.
No upstream implementation is copied. The API reference is Bun's
`src/js/node/fs.promises.ts` `watch()` at pinned revision
`9510e74152073d850a18758ca41114d8f214ffa6`. Native comparisons use Bun 1.4.4
and Node 26.12.1. Bun returns an async iterable whose iterator has `next` and
`return`. The adapter preserves that shape.

The existing callback watcher owns filesystem observations, options and filename
encoding. This adapter queues its events, wakes pending readers and closes it on
iterator return, abort or error. Aborts reject once with `AbortError`, `ABORT_ERR`
and the original signal reason. Pre-aborted signals open no watcher. Terminal
paths detach change, error, close and signal listeners, clear the closed watcher
reference and finish pending reads. The iterator no longer retains the backend
snapshot after completion. The real callback-backend regression covers return,
abort, polling error, external close and a for-await break. The adapter
adds no filesystem polling, subscription, native operation or Waffle protocol.
The existing [callback backend's limits](portable-filesystem-watcher.md) apply.

Vinxi 0.5.8 `lib/build.js:426` imports `runtime/sh.js` before spawning a router
build. That module re-exports dax-sh 0.43.2, whose `esm/mod.js:131` imports
`@deno/shim-deno` 0.19.2. The shim's `dist/index.mjs:1905` imports `{ watch }`
from `fs/promises`. Linking needs the real export even if `Deno.watchFs` is never
called. The discovery script reads those archive members from the captured
registry cache and verifies their hashes. It retains only import statements,
not upstream implementations.

Run the focused checks with:

```sh
source env.sh
bun scripts/discover-solid-watch-import.ts /work/cache/bun-wasm-app-matrix
bun test scripts/fs-promises-watch.test.ts
bun tests/fixtures/fs-promises-watch-import/index.ts
```

The source test links the exact public import against the production host-engine
ESM wrapper with Node's native module linker. It exercises event order, pending
reads, close, error, abort and cleanup, and compares native filesystem events
against the production promise adapter over native `fs.watch`. This is not a
SolidStart acceptance run or a Waffle notification test. The retained app log
contains no blob-to-module map. The source trace and reduced failing link earn
the API correction; the next owned app run must confirm application progress.

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `fs_promises_watch.ts`, `node_fs.js` wiring | Host feature | Original async-iterator adapter over the existing callback watcher. |
| Discovery and import fixtures | Host feature | Original source trace and exact public-import controls. |
