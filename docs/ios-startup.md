# iOS startup measurements

Measured on 2026-10-15 against baseline `ca91913` and branch `ios-startup`.
The sandbox still builds the user's modules and React dependencies inside bun.wasm in the browser.

## First visit

Two guarantees were missing. `registration.active` can refer to an `activating` service worker,
but the old `activated()` returned immediately in that state. Also, the scoped worker bootstrap
had no static file: the public `__bunwasm/worker.js` returned HTTP 404 without interception.
A first worker whose initial request reaches the network therefore fails before executing its code.
Safari can send a plain error event without `message`, which printed `worker error: undefined`.

The fix waits for the actual `activated` state, rejects redundant registrations, and ships the
worker bundle at `__bunwasm/worker.js` in both apps. The error includes the requested URL and a
fallback description when Safari omits the message.

Fresh proxy origins hold activation open for six seconds and return registration during
`activating`. Before the fix, Chromium and WebKit both start the Bun worker prematurely, and the
static bootstrap check returns 404. After the fix, both suites wait and the static script returns
200 with COEP. Real iOS Safari also starts the worker only after activation in two sandbox runs
and a playground import-cycle run. Safari queued the initial request in the delayed baseline run;
the original public failure was not spontaneously reproduced on fast localhost. The tests check
both missing guarantees instead of relying on that intermittent error signature.

## Changes that affect startup

- Engine bytes are cached in Cache Storage by the SHA256 of the exact wasm build. Return visits
  compile cached uncompressed bytes and skip the network and decompression. A failed cached
  compilation evicts that entry and downloads a fresh copy.
- `WebAssembly.compileStreaming` consumes the decompressed stream on first visits.
- The sandbox caches bun.wasm's dependency bundle and import map. Its key includes the engine,
  engine SHA256, and complete template SHA256, covering package versions and dev.ts. Restart and
  return visits restore output instead of invoking `bundleDeps()`. User edits to dev.ts,
  package.json, or node_modules disable that reuse. Invalid JSON or missing entries rebuild and
  repair the cached output.
- Small fingerprint markers avoid opening empty caches on first visits. Old output for an engine
  is replaced, so these persistent caches do not accumulate one copy per release.
- The status line shows download bytes, decompression and compilation, worker startup, dev.ts,
  React bundling, and preview loading. Phone layouts now show loading and error status in a third
  header row and hide the row when ready. Ordinary stdout still streams without a newline.

A cache test also exposed a JSC bridge defect. `JSObjectGetTypedArrayBytesPtr` returns the backing
buffer pointer, not the view start. Adding `JSObjectGetTypedArrayByteOffset` fixes native reads of
subarrays. Previously, dependency responses larger than 1 MiB repeated bytes after a partial
socket write. The rebuilt JSC engine passes both a subarray file roundtrip and a response over
1 MiB.

## Measurement conditions

The simulator is iPhone 17, iOS 26.5, on the owner's M1 Mac. A new unused localhost port supplies
a new origin for each first visit, with no existing service worker or cache. A probe then uses
`location.replace` for the return visit in the same tab. All servers send COOP and COEP.
Localhost transfer times measure the implementation, not the owner's cellular connection.

Chromium runs with CDP page CPU throttling at 6x. A second pass adds 10 Mbps download bandwidth
and 40 ms latency. CDP does **not** throttle dedicated worker CPU: a fixed loop took 13.4 to
79.6 ms on the page but 13.2 to 13.2 ms in a worker. A worker-target throttle request was rejected
as supported only for pages. These runs slow the UI and React, not the wasm worker.

Each cell below is **before → after**, rounded to milliseconds. These are individual bounded
runs, not statistical medians. The final phone status-row CSS change followed the timing run;
the final screenshots and phone geometry tests cover that layout change.

Phases overlap and must not be added. The decompression pipeline includes waits for incoming
bytes and main-thread scheduling. Before, compilation starts after decompression. After,
streaming compilation includes download and decompression, so its wall time is not standalone
compiler CPU time. The combined window is the comparable measure. Return visits after the fix
compile cached bytes. The React measurement observes the counter DOM and two animation frames;
its final phase also includes the probe's sampling delay.

### iOS Safari, localhost

| Phase, ms | Browser first | Browser return | QuickJS first | QuickJS return |
|---|---:|---:|---:|---:|
| Wasm download | 23 → 22 | 11 → 0 | 24 → 22 | 14 → 0 |
| template.json download | 18 → 17 | 9 → 8 | 19 → 12 | 8 → 7 |
| Decompression pipeline | 30 → 58 | 16 → 0 | 30 → 83 | 17 → 0 |
| Compile wall time | 38 → 69 | 35 → 23 | 50 → 88 | 30 → 31 |
| Decompression + compile window | 80 → 69 | 52 → 23 | 83 → 88 | 49 → 32 |
| Worker script start | 14 → 32 | 11 → 11 | 15 → 25 | 10 → 9 |
| Worker ready to dev.ts entry | 42 → 44 | 39 → 41 | 78 → 85 | 75 → 89 |
| dev.ts before bundle | 4 → 4 | 3 → n/a | 14 → 14 | 14 → n/a |
| Bundle deps or restore output | 181 → 187 | 171 → 5 | 184 → 198 | 181 → 17 |
| First preview document | 12 → 9 | 7 → 8 | 8 → 8 | 7 → 8 |
| Preview module request window | 34 → 37 | 34 → 49 | 38 → 36 | 38 → 55 |
| Last module response to rendered React | 56 → 34 | 45 → 38 | 33 → 56 | 52 → 60 |
| Navigation to rendered React | 563 → 558 | 468 → 302 | 614 → 644 | 535 → 405 |

Browser return visits improve from 468 to 302 ms. QuickJS improves from 535 to 405 ms.
First visits remain close: Browser 563 to 558 ms and QuickJS 614 to 644 ms.
JSC also passes cold and return visits, at 1090 and 717 ms after the fix.

### Chromium, 6x page CPU, localhost

| Phase, ms | Browser first | Browser return | QuickJS first | QuickJS return |
|---|---:|---:|---:|---:|
| Wasm download | 53 → 76 | 100 → 0 | 55 → 74 | 98 → 0 |
| template.json download | 7 → 4 | 3 → 2 | 6 → 5 | 2 → 2 |
| Decompression pipeline | 199 → 252 | 195 → 0 | 214 → 273 | 204 → 0 |
| Compile wall time | 19 → 266 | 19 → 74 | 22 → 289 | 21 → 121 |
| Decompression + compile window | 239 → 266 | 235 → 74 | 258 → 289 | 245 → 121 |
| Worker script start | 52 → 88 | 29 → 24 | 47 → 89 | 30 → 23 |
| Worker ready to dev.ts entry | 34 → 31 | 16 → 14 | 53 → 54 | 20 → 19 |
| dev.ts before bundle | n/a → n/a | n/a → n/a | n/a → n/a | n/a → n/a |
| Bundle deps or restore output | 120 → 136 | 85 → 5 | 106 → 126 | 68 → 7 |
| First preview document | 7 → 8 | 9 → 6 | 26 → 31 | 8 → 9 |
| Preview module request window | 61 → 66 | 37 → 67 | 43 → 38 | 37 → 67 |
| Last module response to rendered React | 189 → 215 | 42 → 28 | 186 → 224 | 27 → 45 |
| Navigation to rendered React | 1183 → 1290 | 635 → 520 | 1155 → 1310 | 621 → 556 |

The localhost first visit regresses by 106 ms on Browser and 154 ms on QuickJS. Cache population
and the streamed main-thread pipeline add work on that first visit. Return visits improve, and
both caches are asserted to hit. This change does not eliminate the engine's first download.

### Chromium, 6x page CPU, 10 Mbps and 40 ms latency

| Phase, ms | Browser first | Browser return | QuickJS first | QuickJS return |
|---|---:|---:|---:|---:|
| Wasm download | 3727 → 3726 | 112 → 0 | 3963 → 3961 | 107 → 0 |
| template.json download | 2237 → 2236 | 44 → 43 | 2236 → 2237 | 45 → 43 |
| Decompression pipeline | 3709 → 3707 | 199 → 0 | 3946 → 3951 | 210 → 0 |
| Compile wall time | 15 → 3721 | 19 → 150 | 20 → 3964 | 23 → 135 |
| Decompression + compile window | 3745 → 3721 | 238 → 151 | 3988 → 3965 | 254 → 135 |
| Worker script start | 46 → 82 | 33 → 21 | 78 → 81 | 50 → 48 |
| Worker ready to dev.ts entry | 35 → 34 | 19 → 12 | 51 → 55 | 24 → 17 |
| dev.ts before bundle | n/a → n/a | n/a → n/a | n/a → n/a | n/a → n/a |
| Bundle deps or restore output | 121 → 137 | 83 → 5 | 107 → 116 | 68 → 7 |
| First preview document | 7 → 7 | 5 → 4 | 28 → 8 | 5 → 5 |
| Preview module request window | 72 → 63 | 40 → 36 | 51 → 105 | 32 → 45 |
| Last module response to rendered React | 191 → 217 | 53 → 49 | 183 → 207 | 30 → 48 |
| Navigation to rendered React | 5705 → 5550 | 771 → 539 | 5867 → 5803 | 757 → 590 |

The first wasm download dominates this constrained connection. Browser first visits improve
from 5705 to 5550 ms and QuickJS from 5867 to 5803 ms. Return visits improve from 771 to 539 ms
and 757 to 590 ms. The network benefit comes from reusing engine bytes on later visits.
Public Cloudflare already compresses template.json through Content-Encoding; the loader keeps
that native response handling rather than adding another manual decompression pipeline.

## Verification and evidence

The branch includes first-visit tests in the playground and sandbox suites, output-cache tests,
a streaming stdout unit test, and the typed-array regression. Cache tests check Restart, reload,
Fast Refresh state, corrupt output recovery and repair, package edits, and zero wasm download
or decompression on a cache hit. The mobile layout test checks status visibility at 320, 375,
393, and 430 pixels.

The installed Playwright WebKit 26.6 ephemeral context loses Cache Storage entries on reload,
even for an eight-byte response with no wasm, service worker, or COOP. localStorage survives.
Fresh persistent WebKit profiles retain the entries, matching real iOS Safari. Cache regression
tests therefore use a fresh persistent profile for WebKit and delete it after each run. The
minimal upstream report lives in `/work/reports/upstream-bugs/README.md`; nothing was posted.

Results are retained in `/work/tmp/bun-wasm-ios-startup-results/`:

- `ios-comparison.json`, `chromium-comparison.json`, and `chromium-network-comparison.json`
- Raw before and after records, build fingerprints, CPU throttle proof, and test logs

Screenshots are retained in `/work/tmp/bun-wasm-codex-shots/ios-startup/`, including
`ios-final-visible-loading.png`, `ios-final-visible-ready.png`, the three engine return visits,
and `ios-playground-{browser,quickjs,jsc}.png`.

## Profiling commands

From the worktree root, the profiler accepts the built site and an output directory:

```sh
source env.sh
export PLAYWRIGHT=/home/shaul/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/.mise/playwright@1.63.0/node_modules/playwright/index.mjs
node sandbox/tests/startup-profile.mjs --root site/dist --out /work/tmp/bun-wasm-profile-after --cpu 6 --require-cache
node sandbox/tests/startup-profile.mjs --root site/dist --out /work/tmp/bun-wasm-profile-network-after --cpu 6 --network-mbps 10 --latency 40 --require-cache
python3 sandbox/tests/startup-compare.py BEFORE_DIRECTORY AFTER_DIRECTORY OUTPUT.json
```

`profile-baseline.py BUILT_BASELINE_DIRECTORY` adds timestamped worker and dev.ts markers to a
disposable baseline build. It changes generated JS and template.json, and leaves engines intact.
The baseline predates the cache, so its profiler invocation omits `--require-cache`.

For Safari, `profile-server.py --root SITE_DIRECTORY --results RESULTS_DIRECTORY --port UNUSED_PORT`
serves a local build on the Mac. `startup-probe.js` must be beside that Python script.
The query `?engine=browser&profile=ios-cold&reloadProfile=ios-return` records both visits in one tab.
`--activation-delay-ms 6000` and `&activationRace=1` exercise the activation transition.
At `/playground/`, `&playgroundRun=1` runs cyclic imports and checks exit zero.
The server writes JSON results and timestamped request logs. These flags change only the test
server and injected probe; they do not add a profiling upload to the shipped app.

## Final checks and cleanup

The following checks pass on the branch:

```sh
(cd web && bun run check)
(cd sandbox && bun run check)
scripts/test-web.sh
bun test sandbox/tests/startup-output.test.ts
node sandbox/tests/hmr-check.mjs LOCAL_SITE_URL
node sandbox/tests/startup-cache.mjs LOCAL_SITE_URL
ENGINE=jsc node web/tests/browser-engine.mjs
```

HMR and cache checks cover Chromium and WebKit on all three engines. JSC was rebuilt with
`JOBS=6 scripts/build-bun-jsc.sh` and workspace version 0.0.2. The site was rebuilt after the
phone status CSS change and its screenshots were checked in the real simulator.

Cleanup was checked on both hosts. All 20 test origins had their service workers, Cache Storage,
and localStorage cleared. All task servers stopped, the Mac's copied site and probes were
deleted, the disposable local baseline was removed, and the simulator reports `Shutdown`.
Pre-existing toolchains, services, and the shared JSC build cache were preserved.

The requested review worktree remains at `/work/worktrees/bun-wasm/ios-startup`, 322 MiB including
installed dependencies and build outputs. It includes the rebuilt `dist/bun-jsc.wasm`, copied
Browser and QuickJS engines, and `site/dist`. The raw engine directory is 62 MiB and the site
output is 41 MiB. These remain for the coordinator to review and integrate, then remove with
the worktree. Results occupy 756 KiB. Screenshots occupy 5.7 MiB in `ios-startup` and 6.4 MiB in
`ios-startup-first-visit`; their cleanup owner is the coordinator after evidence review.
The checked cleanup record is `/work/tmp/bun-wasm-ios-startup-results/cleanup-summary.json`.
