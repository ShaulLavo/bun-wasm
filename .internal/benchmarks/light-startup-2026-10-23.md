# Bun light downloads and startup

This measures served production builds, not bundle-file estimates. The original comparison
uses main `d48dc3d2`, the pre-review PR build `26476bdb`, and the pre-Waffle main commit
`04022389` from October 16.

## Reproduce

```sh
source env.sh
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
(cd sandbox && bun install --frozen-lockfile)
bun web/build.ts
bun sandbox/build.ts
bun run bench:light-startup --samples 5 --port 48941 --output light-startup.json
```

Install the Playwright Chromium engine first if it is not already available. The build needs
`dist/bun-browser.wasm`, or an explicit `BUN_BROWSER_WASM` pointing at the verified guest.
To compare checkouts, build both apps in each checkout and add `--before /path/to/main`
and `--baseline /path/to/old-main`. Revision arguments `--revision`, `--before-revision`
and `--baseline-revision` record provenance when an archived source tree has no Git metadata.

## Method

- Cloud Linux, UpCloud's four-vCPU host, an exclusive benchmark queue slot, Bun 1.4.4 and
  headless Chromium 156.0.8078.4. All revisions run on that same host in alternating order, five samples
  each. These are loopback-download timings, not public-internet latency measurements.
- Every sample starts a new browser process and empty context. Default persistent IndexedDB
  storage is cold. Neither the browser cache nor the filesystem workspace carries between
  samples. The OS file cache is not flushed.
- A real HTTP server sends gzip level 9 response bodies. Compression finishes before
  navigation. Nothing intercepts fetches or replaces the downloaded WASM. Server-side logs
  include page, worker and service-worker requests, including repeated URLs.
- Phase boundaries compare request arrival at the server with the browser's navigation clock.
  They are requested response-body bytes, not headers, TLS overhead, or partial-transfer
  progress. `bytes` is the original minified JS body size; `gzip` is the body actually sent.
  In all-asset totals, a `.wasm.gz` file remains an already-compressed asset in both columns.
- The first parsed shell prompt immediately submits
  `bun -e 'console.log("LIGHT_OUTPUT_" + "OK")'`. Web stdout timing observes the parsed
  terminal output, not a worker message or a polling delay. Sandbox has no shell prompt or
  separate `bun -e`; it auto-starts React. Its command banner, first terminal write, and
  preview-ready indicator are separate measurements. Requests continue to be observed for
  300 ms after command completion or preview readiness.
- JS source maps attribute generated spans to runtime or demo code. Runtime gzip figures
  compress those spans separately and are **estimates, not actual wire bytes**. Whole-file
  download figures are actual gzip transfers. The classic service worker is all runtime.
  Process identities, reservation stubs and outcome/control words are required eager code;
  the supervisor, registry and process transport are the lazy service.

## What changed

The demos previously imported the Bun runner while loading engine metadata. Engine download
and service-worker registration now live separately, so execution adapters load on the first
command. Command-code and process-service loading overlap with the pending engine load after
submission. Nothing activates the process service before the first command.

A combined multi-entry build also hoisted shared code into chunks fetched separately by the
page and filesystem worker. Each browser realm now builds independently, preserving sharing
between a realm's own eager and dynamic imports. Workers no longer download unrelated page
code merely because another entry needs it. Scoped worker chunks are still mirrored for Safari.

The artifact-free size report still uses its own combined build configuration. It is not a
substitute for these production-build downloads. This PR does not change that report or its
size gate.

## Historical pre-review download results

[Raw results](light-startup-2026-10-23.json) contain every request, worker-creation time,
all-asset totals and mapped chunk identities for 60 browser samples. Values below are bytes,
not KiB. JS totals include UI and repeated downloads. They were identical across five samples
for each app/revision. "Fixed" below means pre-review build `26476bdb`, not the final
worker layout. "After" is cumulative, not another copy to add to "before".

| App / revision | Before command raw / gzip | Additional raw / gzip | After command raw / gzip |
| --- | ---: | ---: | ---: |
| Web old main | 953,964 / 292,751 | 55,156 / 18,580 | 1,009,120 / 311,331 |
| Web main | 1,412,183 / 424,723 | 465,367 / 150,232 | 1,877,550 / 574,955 |
| Web fixed | 1,195,252 / 360,615 | 398,517 / 129,079 | 1,593,769 / 489,694 |
| Sandbox old main | 1,005,912 / 313,704 | 55,028 / 18,535 | 1,060,940 / 332,239 |
| Sandbox main | 1,464,523 / 445,767 | 437,264 / 140,804 | 1,901,787 / 586,571 |
| Sandbox fixed | 1,247,378 / 381,949 | 370,850 / 120,319 | 1,618,228 / 502,268 |

Initial web JS saves 216,931 raw bytes and 64,108 gzip bytes. Sandbox saves 217,145 and
63,818. These are real response-body savings, including filesystem-worker downloads.
The current published guest adds 5,104,498 compressed bytes before command submission;
sandbox also downloads its React source template. All-asset initial gzip totals are
5,468,371 for fixed web and 5,716,132 for fixed sandbox.

### Which chunks load

A representative fixed-web sample requests `main.js` at 34 ms, its shared main chunk at
75 ms, `fs-worker.js` at 120 ms, then `sw.js` twice at 128 and 172 ms. Both service-worker
responses count. The initial JS graph is 5 responses, with no generic process service,
Bun runner or executor. Filesystem and service workers are intentionally eager.

After submission at 354 ms, dynamic runner and supporting chunks start at 353-359 ms.
The apparent 1 ms overlap is the server's integer wall clock versus browser monotonic time.
The process supervisor and broker chunks arrive at 393 ms. The Bun execution worker starts
at 418 ms and requests its own worker/chunks from 421 ms onward. Exact URLs, hashes and
phase boundaries are in the JSON. Chunk names vary by app and compiler.

Both apps have zero mapped demo-UI sources in worker downloads. Main's generic Waffle
process service was already lazy. The leak fixed here was the Bun-specific execution
adapter graph, plus redundant cross-realm shared chunks. Tests also check the initial
metafile graph, rather than relying only on source-map classification.

## Historical pre-review cold startup results

Times are milliseconds from navigation. Each cell is median [minimum, maximum], five
fresh browser processes. Web output is the first parsed `bun -e` sentinel. Sandbox has
no interactive shell; its preview-ready state is the useful endpoint. Its first terminal
write is separately retained in the JSON and can occur after preview readiness.

| Revision | Web first prompt | Web first output | Sandbox preview ready |
| --- | ---: | ---: | ---: |
| Old main `04022389` | 176.85 [172.11, 198.18] | 353.09 [350.30, 394.23] | 397.07 [378.05, 404.87] |
| Main `d48dc3d2` | 346.12 [325.20, 357.39] | 519.69 [490.94, 550.02] | 588.09 [563.73, 594.45] |
| Fixed `26476bdb` | 328.93 [320.88, 364.01] | 498.89 [483.14, 541.17] | 573.69 [541.07, 613.31] |

The fixed medians improve on main in this run, but the ranges overlap. A second control
with one identical legacy guest across all three hosts gives these medians:

| Revision | Web prompt | Web output | Sandbox preview ready |
| --- | ---: | ---: | ---: |
| Old main | 194.82 | 378.19 | 405.50 |
| Main | 351.02 | 536.78 | 585.59 |
| Fixed | 351.67 | 536.32 | 569.09 |

Do not claim a proven web-latency improvement from five samples. The transfer reduction is
repeatable; web startup is effectively unchanged from current main in the matched control.
The historical regression remains in both runs, about 157 ms to prompt and 158 ms to output
in the matched control. An attempted earlier WASM download competed with filesystem setup
and made prompt timing worse; that scheduling change was discarded.

### Guest and source provenance

The primary run uses the current published guest for main and fixed, SHA-256
`6d2c90d4adba7a964c819b63f44ea54b3f91478106b3a7c90722546380f8adfc`.
The old host uses a preserved later compatible legacy guest, SHA-256
`935010625e28051815aae6d3c7e95eb2d0d2251db3e9ab67a0e5ac795ae87422`.
The original October 16 guest was unavailable. This is a historical host comparison,
not a reconstruction of the original release environment. The second run uses that exact
legacy guest everywhere; it prints the sentinel and serves React on all three hosts.

The build compiler and installed toolchain are identical across revisions. Main
`d48dc3d2` includes the accepted Waffle pin. Later main commits `7fd1baa9` and `56d2dd3c`
change CI or test checks, not the measured browser source, build settings or runtime pin.
The original measured fixed commit is `26476bdb`. It predates the review fix for Linux
WebKit worker-entry identity. Its figures describe that historical build, not the final
worker layout. The JSON preserves the actual measured SHA.

Evidence came from exclusive cloud gate
`light-downloads-process-overlap-20261023T065410Z-sio89l8o`. JS quality passed, 79 focused
tests passed, and restoring the old multi-entry builder made the new realm-isolation test
fail as expected. All 60 browser samples succeeded; queue exit and teardown status were 0.
The JSON extraction receipt records removal of exact interleaved missing-artifact warning
lines from combined stdout/stderr. No measurements were replaced or edited.

## Final worker layout and review fixes

The reviewed build is `8d1d8717e9eaa55df058a828f4fcb7257bd49067`. Linux WebKit evaluated
worker entries twice when lazy chunks imported them, breaking process-class identity.
The builder now detects those back edges and moves shared exports into ordinary chunks.
The editor fixture also mocks the new engine-loader boundary. Split tests cover the correct
one-chunk realm-local fixture and a genuinely shared static/dynamic worker fixture.

All seven CI checks passed on this exact build in run `39922213548`, including Web host,
Processes on Chromium/Firefox/WebKit, and Rust workspace tests. An independent review
passed 57 focused tests and verified worker identities, lazy process services, no worker
demo UI, and complete mirrored chunks. These are correctness checks, not download timings.

Final-layout performance is **unmeasured**. A frozen-source 30-sample rerun was queued on
UpCloud's exclusive four-vCPU host, but its 3,600-second deadline expired before admission.
No benchmark command or browser sample ran. The planned main control was `9a087474`,
the old control was `04022389`, and all three would use the identical legacy guest above.
The original published guest was unavailable for this rerun. No historical sample has
been relabeled as a final-layout result, and no final size or startup claim is accepted.

The JSON's `evidence.finalWorkerLayout` records the source/archive hash, planned guest,
zero completed samples, deadline, statuses, and cleanup. Retained gate evidence is
`pr126-worker-identity-final-downloads-20261023T080835Z-w982wj5r`. The dispatcher returned
124 for its deadline and verified teardown. A separate actual-host probe confirmed the
owned checkout, staging directory, and queue entry absent. No task browser or server started.

## Budget verdict and remaining work

Item 9 remains open. Historical pre-review runtime source-span estimates for initial web JS
are 72,549 raw / 25,987 gzip bytes on old main, 524,484 / 154,902 on main and
308,510 / 91,392 on pre-review fixed. That runtime is about 301 KiB raw / 89 KiB gzip,
well above 100 / 35, even after excluding terminal and editor UI. Fragment gzip is an attribution estimate, not a wire-size claim.
The entire filesystem worker alone downloads 146,933 raw / 40,346 gzip bytes on web,
which already exceeds both guides.

The remaining size work belongs in Waffle's filesystem worker and page-side filesystem
imports, not the separate core-chunk gate. `browser/fs-worker.ts` loads filesystem service
and backend code, including both storage backends. Profile cold filesystem startup through
`onStartupStage`, then page seeding/setup, before claiming that filesystem startup causes
all of the latency gap. The timing evidence establishes a regression, not its full cause.
Neither runtime budget nor historical startup may be marked accepted from this PR.
