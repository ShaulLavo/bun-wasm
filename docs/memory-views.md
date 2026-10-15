# Wasm memory views

The JavaScript hosts share one `memoryViews(memory)` owner per wasm memory. If the engine exposes `WebAssembly.Memory.prototype.toResizableBuffer()`, the owner creates one length-tracking `Uint8Array` and one length-tracking `DataView`. Both keep their identity and grow with the memory. Hosts without the API recreate those views when accessed.

`toResizableBuffer()` also returns a growable `SharedArrayBuffer` for a shared wasm memory. None of our three wasm artifacts uses shared memory. The shared buffers in the network ring and subprocess pipes are separate IPC buffers. They do not change.

Calling `toResizableBuffer()` changes what `memory.buffer` returns. The WeakMap owner prevents different hosts from repeatedly converting the same memory. Bounded `range(ptr, length)` views still allocate and preserve the constructor's out-of-bounds checks. Byte results and asynchronous network payloads still copy out of guest memory with `slice()`. Strings are copied before TextDecoder because Chromium rejects resizable backing buffers at that API boundary.

The browser engine's result reader uses absolute offsets into the shared full-memory views. It no longer creates a DataView over each result. Argument writes acquire their view after the guest allocator returns. WASI result writes reacquire their view after a host callback, since that callback can grow memory on a host without the API.

## Reproduce

Build all three wasm artifacts and install the web and site dependencies. Build baseline hosts in a separate worktree. Point both site builds at the same rebuilt wasm files with absolute `BUN_WASM`, `JSC_WASM` and `BUN_BROWSER_WASM` paths. Serve each site on a free port with `ROOT=$PWD/site/dist PORT=0 bun web/serve.ts`. Run this branch’s benchmark script against each URL. `PLAYWRIGHT` can point to an installed Playwright module.

```sh
node web/tests/bench-memory.mjs http://127.0.0.1:<port>/ before.json
node web/tests/bench-memory.mjs http://127.0.0.1:<port>/ after.json
node web/tests/compare-memory.mjs before.json after.json
```

The benchmark takes five samples per browser, each in a fresh context. Each sample measures navigation to the playground's ready status, 50,000 small `Bun.hash` native calls through the browser-engine bridge, 50,000 `process.cwd()` calls returning strings, 2,000 `console.log` calls through WASI `fd_write`, and navigation to the React sandbox's first counter render. Microbenchmarks warm up once before measurement. Guest timings exclude worker startup and terminal draining; wall timings include shell execution and output delivery. Fresh contexts clear browser storage and the sandbox's dependency-bundle cache. Browser processes are reused across samples, so wasm compilation can benefit from process caches. The sandbox bundles React with bun.wasm.

These are host measurements on a machine shared with other wave lanes. Startup and first render include work beyond memory views. They do not establish a general speedup. Each sample records React root commits through the DevTools renderer hook, and the comparator requires matching counts. No React component or render logic changes.

## Growth checks

`bun test web/tests/memory-views.test.js` checks ordinary and shared memory, feature detection, forced fallback, view identity, copied slices, bounded ranges, and both positive and zero-page growth.

`web/tests/browser-memory.mjs`, included in `scripts/test-web.sh`, repeats view checks in Chromium and WebKit. It runs the `memory-grow` fixture on QuickJS, JavaScriptCore and the browser engine in both browsers. The fixture makes host calls before and after writing and reading a 48 MiB buffer. The regular CLI fixture gates run it on all three engines too.

## API support measured on 2026-10-15

| Host | Version | `toResizableBuffer()` | Views track positive growth | `toGrowableSharedArrayBuffer()` |
|---|---|---|---|---|
| Playwright Chromium | 153.0.8010.12 | Yes | Yes | Absent |
| Playwright WebKit | 26.6 | Yes | Yes | Absent |
| iPhone 17 simulator Safari | iOS 26.5, build 23F77 | Yes | Yes | Absent |
| Node | 26.7.0 | Yes | Yes | Absent |

The simulator probe booted device `10128D70-92A7-4626-9CE5-1537CF27BE84`, opened a local page through an SSH reverse tunnel, posted its API result, and captured a screenshot. After growing one page to two, its original byte view and DataView both reported 131,072 bytes. The probe shut down the simulator and removed the tunnel and remote files. Node and Bun also pass the shared-memory growth tests through `toResizableBuffer()`.

The targeted upstream census covers `js/bun/util/hash.test.js` and `js/node/console/console.test.ts`. The baseline cannot collect either file on any engine because `bun:internal-for-testing.xxHash3ForTesting` and `node:console.Console` are missing. Those collection failures are reported as two synthetic failures per engine. They do not count as executed upstream assertions.

## Host timings measured on 2026-10-15

Baseline hosts are main `aeb5526`. Both builds use the same rebuilt wasm files. Each value is the median of five samples in milliseconds. Lower elapsed time is better.

| Browser | Workload | Before median ms | After median ms | Change |
|---|---|---:|---:|---:|
| chromium | navigation to ready | 160.24 | 159.65 | -0.4% |
| chromium | 50,000 native calls (guest) | 69.93 | 66.63 | -4.7% |
| chromium | 50,000 string native calls (guest) | 33.59 | 34.42 | 2.5% |
| chromium | 2,000 console writes (guest) | 6.63 | 6.90 | 4.1% |
| chromium | 50,000 native calls (wall) | 84.34 | 85.63 | 1.5% |
| chromium | 50,000 string native calls (wall) | 50.45 | 51.71 | 2.5% |
| chromium | 2,000 console writes (wall) | 20.16 | 20.82 | 3.2% |
| chromium | sandbox first render | 356.80 | 362.72 | 1.7% |
| webkit | navigation to ready | 329.78 | 330.76 | 0.3% |
| webkit | 50,000 native calls (guest) | 36.44 | 30.60 | -16.0% |
| webkit | 50,000 string native calls (guest) | 32.90 | 31.82 | -3.3% |
| webkit | 2,000 console writes (guest) | 6.06 | 6.64 | 9.6% |
| webkit | 50,000 native calls (wall) | 56.34 | 51.58 | -8.4% |
| webkit | 50,000 string native calls (wall) | 52.08 | 49.04 | -5.8% |
| webkit | 2,000 console writes (wall) | 24.42 | 24.00 | -1.7% |
| webkit | sandbox first render | 520.24 | 521.21 | 0.2% |

chromium React root commits: before 1,1,1,1,1; after 1,1,1,1,1.
webkit React root commits: before 1,1,1,1,1; after 1,1,1,1,1.

Integer native-call guest time fell 4.7% in Chromium and 16.0% in WebKit. Small-write guest time rose 4.1% and 9.6%. String-returning calls, startup and first render showed small changes. Wall times also include worker startup and message delivery. These are mixed results on a shared machine, rather than evidence of a uniform speedup.

The repository has no `trace --compare` command. The committed comparator checks identical wasm hashes, different host-worker hashes, equal React root-commit counts and the recorded timings. Raw runs and support screenshots are retained in `/work/reports/bun-wasm-resizable` for coordinator review.
