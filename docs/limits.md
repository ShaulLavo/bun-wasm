# Limits

Hard limits of the project at this revision: memory, stack, threads, processes, network, filesystem, browsers. Each entry names where the number or behavior comes from. For what runs and what fails on top of these limits, see [Compatibility](compatibility.md).

bun-wasm is pre-1.0 and experimental. The package is version 0.0.58 and private. Treat everything below as the current state, not a promise.

## Memory

| Limit | Value | Source |
| --- | --- | --- |
| Linear memory of one guest | 1 GiB maximum (`--max-memory=1073741824`) | `crates/bunwasm-cli/max-memory.txt`, the one source for every link, admission check and JSC's heap sizing. A maximum is not memory a device can supply. See [Memory ceiling](memory-ceiling.md). |
| Typed arrays live at once on JSC | About 485 MiB before `RangeError: Out of memory`, measured at the earlier 512 MiB maximum | [JavaScriptCore for wasm32-wasip1](jsc-build.md) |
| Small live objects on JSC | About 3 million (QuickJS: about 4 million) | same |
| Heap exhaustion on JSC | The process aborts instead of throwing | same |
| JS heap of a headless Node child | 128 MiB | [Playground](playground.md#bun-subprocess-workers) |

A package install that needs more than the maximum fails with `memory allocation of N bytes failed`. Prisma 6.17.1 failed this way at the earlier 512 MiB maximum in the app matrix snapshot.

## Stack

Deep recursion must reach the engine's own stack guard, which throws a catchable `RangeError`. A host stack overflow is a wasm trap. A trap ends the program, and no JavaScript `catch` runs.

| Host | Stack |
| --- | --- |
| Native launcher | 16 MiB wasm call stack (`BUN_WASM_HOST_STACK_KIB` changes it) |
| Safari and WebKit on Apple platforms | 512 KiB for a worker thread, the smallest host |
| V8 in Chromium and Node | The engine's stack limit |

JSC leaves some deep-nesting paths unguarded: its parser, regular-expression compiler, `Array.prototype.flat`, `JSON.parse` revivers and trap-less Proxy chains still trap when nested deeply. [Stack overflow in wasm](stack-limits.md) has the measured depths per engine and host.

## Threads

Each guest is single-threaded. None of the three wasm artifacts uses shared memory. `node:worker_threads` and Web Workers run each worker as a separate guest, so workers do not share linear memory ([Worker threads](worker-threads.md), [Wasm memory views](memory-views.md)). Cross-guest `SharedArrayBuffer` was a remaining failure in the worker-thread census.

## Processes

The host never starts a native executable. `Bun.spawn` and `node:child_process` start other guests that the host registered, such as `/bin/bun` and `/bin/node` ([Host ABI](host-abi.md#process-imports)). Each process runs in its own worker.

## Network

| Limit | Behavior | Source |
| --- | --- | --- |
| Cross-origin isolation | The browser page needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without them the wasm engines report network APIs as not supported, and the `browser` engine falls back to the worker's own `fetch` with no servers. | [Playground](playground.md#networking) |
| `fetch` | Runs as the page's `fetch`, so CORS applies. | same |
| Servers | A guest server is reachable through the service worker's `/__preview/<port>/` route, or from inside the same worker. | same |
| Raw outbound TCP in a browser | Fails with `ENOTSUP`. Browsers have no raw TCP API. | [TCP on the host ABI](tcp.md) |
| Loopback pipes in a browser | Queue up to 1 MiB per direction. | same |
| TLS sockets, Unix sockets | Not implemented. An HTTPS upgrade without a caller-supplied TLS connection fails with `ERR_TLS_NOT_SUPPORTED`. | [TCP](tcp.md), [HTTP compatibility](http-compatibility.md) |
| WebSocket | Payloads up to 16 MiB by default. No `permessage-deflate`. | `crates/bunwasm-runtime/src/js/websocket.js` |

## Filesystem

The browser hosts give each guest `/` over an in-memory filesystem with `PWD=/home/user`.

| Mode (`?mode=`) | Behavior |
| --- | --- |
| `fast` (default) | Saves to IndexedDB. A completed `flush()` is a checkpoint, and changes after the last checkpoint can be lost. |
| `memory` | Isolated and not persistent. Reloading discards it. |
| `safe` | Not implemented. Startup fails with `UNSUPPORTED_VFS`. |

[Browser storage modes](storage-modes.md) has the details. A workspace has one owner tab at a time. The page filesystem does not support symbolic links, so workspace and local-link installs fail in the browser ([Installing npm packages](install.md#workspaces-and-commands)).

## Packages and platform

The installer advertises the guest as `linux` on `wasm32`. A package whose optional dependencies need another platform loses those dependencies. A required dependency that needs another platform fails the install. Native addons cannot load.

## Engines

| Engine | Limit |
| --- | --- |
| JSC | No JIT. English is the only `Intl` locale with data. Other locales fall back to root. |
| `browser` | User code shares the worker's global object with the host glue. Isolation is not a goal. See [The browser engine](engine-browser.md). |

No engine is a security boundary. Do not run untrusted code on the assumption that the guest contains it.

## Browsers

The browser gates, including CI, run in Chromium, Firefox and WebKit through Playwright. WebKit through Playwright is not Safari. Real Safari and the iOS simulator have separate manual scripts (`bun run test:browser:safari` in `web/`) that are not part of CI.

| Requirement | Reason |
| --- | --- |
| Cross-origin isolation | Shared memory for `Atomics.wait` sleeps and the network bridge |
| `script-src` allows `blob:` | The `browser` engine loads each acyclic module from a `blob:` URL |
| Service workers | Import cycles on the `browser` engine and server previews |
| Module workers | The `bun-wasm/worker` entry must be bundled as an ES module worker |
