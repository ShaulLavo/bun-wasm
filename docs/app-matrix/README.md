# Real app compatibility

This matrix measures complete app commands after a fresh `bun install` in bun-wasm. It covers 17 pinned projects. QuickJS and JSC use the native launcher and real loopback HTTP. The browser-engine native row uses Node's engine host with the same wasm runtime, not native Bun. Hono, Vite React, Drizzle, Prettier, TypeScript, and ESLint also run inside the playground in headless Chromium, across all three engines.

The fixtures are original minimal projects that import the real published packages. No package implementation is replaced. Vite React uses React's public `createElement` API, and Vite Vue uses Vue's `h` API. SvelteKit uses the static adapter. These projects avoid template generators and their moving defaults.

The recorded commands invoke installed JavaScript entry points with `bun run`. At the time of that measurement, the installer did not create `node_modules/.bin` links. The current installer creates those links and supports package scripts such as `bun run dev`. These historical rows still use their original commands and run each package's actual CLI. Install failures stop execution; dependent commands are `blocked`, never counted as tested failures or passes. Next production start additionally depends on its build passing.

## Reproduce

Build the launcher and wasm artifacts from the same checkout. Set `CARGO_TARGET_DIR`, `BROWSER_CARGO_TARGET_DIR`, and `JSC_CARGO_TARGET_DIR` to private target directories when sharing this machine. Run heavy commands through the machine's slot wrapper.

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
cargo build -j 6 --release -p bunwasm-host
scripts/build.sh
scripts/build-bun-jsc.sh
scripts/build-bun-browser.sh
bun install --cwd web --frozen-lockfile
(cd web && bun run build)

# First recording only. Missing npm metadata and tarballs may reach registry.npmjs.org.
bash /work/tmp/wave-heavy/run.sh --class browser "app matrix recording" -- \
  env PATH="$PATH" scripts/app-matrix.sh --record --reference \
  --cache=/work/cache/bun-wasm-app-matrix \
  --output=/work/reports/bun-wasm-app-matrix/recording

# Offline replay. A missing or corrupt record makes this command fail.
bash /work/tmp/wave-heavy/run.sh --class browser "app matrix replay" -- \
  env PATH="$PATH" scripts/app-matrix.sh \
  --cache=/work/cache/bun-wasm-app-matrix \
  --output=/work/reports/bun-wasm-app-matrix/replay

# Reproduce one project's first blocker on the native launcher.
bash /work/tmp/wave-heavy/run.sh --class light "app matrix hono" -- \
  env PATH="$PATH" scripts/app-matrix.sh --apps=hono --engines=quickjs \
  --hosts=native --output=/work/reports/bun-wasm-app-matrix/hono
```

All options use `--key=value`. `--timeout=90` bounds each command in seconds. Choose a fresh output directory for each run. A complete census exits zero even when apps fail. Missing artifacts, corrupt or absent registry objects, and runner errors exit nonzero. `--apps`, `--engines`, and `--hosts` restrict the run. The playground always restricts apps to its representative subset. `--reference` also runs installed native Bun as a fixture control. Recording runs that control automatically to capture dependency tarballs used on the native platform; native Bun never substitutes for a bun-wasm result.

The cache keeps original abbreviated npm metadata and tarballs by SHA-256, with a request-path index. Metadata and tarball responses remain fixed after the first recording. Package versions and integrity hashes come from those recorded documents. The loopback mirror rewrites registry tarball URLs to itself at replay time, so ephemeral ports do not change recorded bytes. The complete harness, including native launchers, framework subprocesses, web server and Chromium, runs inside a new Linux user/network namespace with only loopback enabled. Linux `unshare` and `ip` are required. Replay has no upstream connection. Non-mirror tarball origins other than the supported npm registry are rejected as infrastructure errors. Recording alone starts an upstream npm broker outside the namespace, reached by the mirror over a private Unix socket. Native commands stay isolated while recording too. Chromium contexts additionally reject requests outside loopback. Telemetry is disabled and Prisma engine downloads are explicitly blocked at the mirror.

`results.json` contains the runtime commit, fixture and runner hashes, wasm hashes, launcher hash, browser build hashes, registry digest, options, and stage records. `results.jsonl` checkpoints each completed stage. `matrix.md` is the complete table. Logs and successful browser preview screenshots stay beside the results. Scratch projects, install caches inside those projects, servers, browser contexts, and launched process groups are removed on completion, errors, and handled signals. SIGKILL cannot run teardown.

## Read the scoreboard

`pass` requires the declared exit and output assertion, or a successful HTTP response with the expected body. Frontend dev checks additionally wait for rendered DOM text in headless Chromium. Build checks require the declared output file and content. Playground servers must answer through their service-worker preview and render the expected page. A server that exits before its HTTP/DOM assertion fails even with exit zero. Install passes require the pinned package names and versions, package main files and declared CLI entry points on disk. TypeScript must emit the clean fixture and reject a deliberate type error with exit 2 and TS2322. ESLint must report zero errors on clean input and reject `debugger` with exit 1 and the `no-debugger` diagnostic. Install success alone does not establish app compatibility.

Categories match [Bun's upstream suite](../bun-test-suite/README.md). They describe the first blocker only.

| Category | Meaning |
| --- | --- |
| a | Platform limitation, backed by a native or OS dependency error. |
| b | Missing subprocess capability. |
| c | Fixable, small, after a bounded reproduction identifies the cause. |
| d | Fixable, big, or unresolved until investigated. |
| e | Not worth the cost, with an explicit reason. |
| f | Measured QuickJS failure that passes on another engine. |

Uninvestigated errors default to d. A package that might eventually require native code is not automatically a platform limitation. Prisma's first measured error takes precedence over its later engine requirements. The runtime commits and artifact hashes identify the implementation tested; this is not a claim about an unbuilt branch.

## Initial results

The native census ran every fixture on native Bun as a control and on QuickJS, JSC, and the browser-engine host. It completed 168 stage records. The four browser playground apps ran on all three engines in headless Chromium and completed 27 records.

| Run | Pass | Fail | Blocked | Notes |
| --- | ---: | ---: | ---: | --- |
| Native Bun control | 39 | 1 | 2 | Fixture control only |
| Native launcher and browser-engine host | 63 | 51 | 12 | Three wasm engines |
| Playground host | 19 | 8 | 0 | Hono, Vite React, Drizzle, and Prettier |

The [regenerated failure classifications](classifications.md) use the retained stage logs, exclude source frames and earlier install warnings, and apply category f only when the same command passes on another wasm engine on the same host. Allocation failures remain d. The original pass counts above predate the stronger TypeScript, ESLint and install assertions; they are historical evidence, not a rerun.

The native run's main blockers were Rollup's native binary refusing the wasm32 platform. That affected Vite, Astro, SvelteKit, and Vitest builds. Next.js and several tooling commands reached missing Node APIs. Prisma installation reached the deliberately blocked native engine download on the control and ran out of wasm memory on the three wasm engines. Express and Koa server startup reached stack inspection differences on QuickJS and JSC. Hono, Elysia, Fastify, and Drizzle passed on all three wasm engines. The browser playground passed Hono and Drizzle on all three engines. Vite React reached the same Rollup blocker. Prettier passed in JSC and failed on missing CLI module resolution in QuickJS and the browser host.

The raw records and logs are in `/work/reports/bun-wasm-app-matrix-2026-10-15/native/` and `/work/reports/bun-wasm-app-matrix-2026-10-15/playground-light/`. The committed reproducer is [the app matrix runner](../../scripts/app-matrix.sh); each row links to its fixture registry.

## Server stack and socket rerun

The 2026-10-16 rerun installs Express 5.1.0 and Koa 3.0.1 from the offline mirror,
then runs the unchanged server fixtures and checks their HTTP response bodies.
All 12 install and server stages pass on the three engines.

| App command | Engine | Before | After |
| --- | --- | --- | --- |
| Express start | QuickJS | Fail, missing CallSite.isEval | Pass |
| Express start | JSC | Fail, captured stack is text | Pass |
| Express start | Browser | Pass | Pass |
| Koa start | QuickJS | Fail, missing CallSite.isEval | Pass |
| Koa start | JSC | Fail, captured stack is text | Pass |
| Koa start | Browser | Fail, empty HTTP body in this rerun | Pass |

QuickJS now supplies the missing CallSite queries, and JSC capture converts its
text frames before invoking a custom stack formatter. Koa then exposed an HTTP
socket gap shared by the engines. Its writable check saw an absent property and
ended the response with no body. The HTTP socket now reports the connection's
existing open and closing states. The earlier census reported a browser Koa pass;
the current baseline rerun observed an empty body and records that failure above.

Koa's cached keygrip metadata also contains an official npm tarball URL using
HTTP. The mirror now routes that URL to its offline cache, as it already does for
HTTPS npm URLs. Package sources and matrix fixtures are unchanged. The registry
regression checks alternate origins and credentials as well as the historical URL.

All 100 fixtures pass on each engine with the current caller-origin changes integrated. The structured-stack and HTTP socket
regressions fail on the preserved baseline for their intended causes and pass
after the fix. The eval-origin regression also rejects synthetic engine filenames
as source metadata; unavailable origins return undefined. The bounded upstream selection remains at 0 of 3 fully passing
files, 0 observed passes and 0 timeouts on each engine, before and after. The capture test still lacks `nativeFrameForTesting`; the other files reach an
unconnected Socket.write and existing formatter failures.

```sh
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light "Express and Koa" -- \
  env PATH="$PATH" scripts/app-matrix.sh --apps=express,koa \
  --engines=quickjs,jsc,browser --hosts=native \
  --output=/work/reports/bun-wasm-app-matrix/server-rerun
bash /work/tmp/wave-heavy/run.sh --class light "stack suite" -- \
  env PATH="$PATH" scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --output=/work/reports/bun-wasm-app-matrix/stack-suite.json \
  js/node/v8/capture-stack-trace.test.js \
  regression/issue/prepare-stack-trace-crash.test.ts \
  regression/issue/23022-stack-trace-iterator.test.ts
```

Repeat the suite command with `--engine jsc` and `--engine browser`, using separate
output paths. Raw before/after records, artifact hashes and fixture logs are in
`/work/reports/bun-wasm-app-blockers-2026-10-16/`, including
`before-native/`, `before-koa-native/` and `after-server-current-native/`.

## Generated CLI import rerun

Prettier 3.6.2 now completes its normal CLI check after a fresh install of the
published package. All six install and check stages pass on the native host,
and all six pass in the playground. No package source or fixture was changed.

| Host | Engine | Before check | After check |
| --- | --- | --- | --- |
| Native | QuickJS | Fail, legacy-cli.mjs resolved from `<input>` | Pass |
| Native | JSC | Pass | Pass |
| Native | Browser | Fail, legacy-cli.mjs resolved from engine host | Pass |
| Playground | QuickJS | Fail, legacy-cli.mjs resolved from `<input>` | Pass |
| Playground | JSC | Pass | Pass |
| Playground | Browser | Fail, missing CLI success output | Pass |

The CLI creates its dynamic importer with the Function constructor. QuickJS
and the browser host lost the creating module's location at that boundary.
Generated functions now use the shared runtime resolver with the creating
module's origin. Native constructors validate the original syntax, then Bun's
parser locates import expressions without changing methods named import. JSC retains its
native constructors. The host adapter retains the creating module's source path
in generated bodies, including bodies without imports, so its constructor proxy
does not hide available caller metadata. The selection also exposed a QuickJS data conversion bug.
A buffer type probe left a pending exception for ordinary arrays and objects;
the bridge now checks buffer class tags before calling the throwing getter.

All 117 fixtures pass on every engine in the current-main rerun. Both targeted
upstream import files pass. The [review rerun](#generated-function-import-review-rerun)
records the complete before/after regression, app and upstream results.

```sh
source env.sh
bash /work/tmp/wave-heavy/run.sh --class build "Prettier native" -- \
  env PATH="$PATH" scripts/app-matrix.sh --apps=prettier \
  --engines=quickjs,jsc,browser --hosts=native \
  --output=/work/reports/bun-wasm-app-matrix/prettier-native
bash /work/tmp/wave-heavy/run.sh --class browser "Prettier playground" -- \
  env PATH="$PATH" scripts/app-matrix.sh --apps=prettier \
  --engines=quickjs,jsc,browser --hosts=playground \
  --output=/work/reports/bun-wasm-app-matrix/prettier-playground
bash /work/tmp/wave-heavy/run.sh --class light "CLI module suite" -- \
  env PATH="$PATH" scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --output=/work/reports/bun-wasm-app-matrix/cli-suite.json \
  js/node/module/node-module-module.test.js \
  js/bun/resolve/concurrent-dynamic-import.test.ts \
  js/bun/resolve/dynamic-import-evaluation-error-gc.test.ts
```

Repeat the suite command with JSC and browser engines, using separate output
paths. Evidence is retained in `/work/reports/bun-wasm-app-blockers-2026-10-16/`,
including `before-native/`, `after-cli-origin-native/`,
`after-cli-origin-playground/` and `cli-suite-final-*.json`. The playground
baseline is the original `playground-light/` census under the 2026-10-15 report.

## Next fixes

These priorities count app projects, not individual command rows.

1. Fix the browser module linker recognizing `import` methods as dynamic-import calls, and implement Bun's `ws` builtin for Vite. The [Rollup rerun](#rollup-distribution-rerun-2026-10-16) records the remaining diagnostics for the six affected projects.
2. Complete Web Streams and replace ambiguous dynamic-import scanning for Next.js. Its earlier CommonJS, vectored-write, and legacy Stream-constructor boundaries are fixed; dev/build/start are still failing or blocked.
3. Completed. Express and Koa pass on all three engines in the [server rerun](#server-stack-and-socket-rerun).
4. Completed. Prettier passes on all three engines in the [generated CLI rerun](#generated-cli-import-rerun).
5. Make Prisma's native-engine limitation explicit in the app fixture and add a WASM engine policy if the upstream package provides one.


Rank remaining causes by the number of distinct app projects they would unblock, rather than counting install, dev, and build rows as separate apps. An install or module-loading fix exposes the next blocker; it does not promise that the app will then pass.

## Browser import parsing follow-up

The browser engine now locates import expressions with Bun's parser. The passing runtime fixtures `import-method`, `import-syntax`, and `import-eval` cover method and property names, strings, comments, regex literals, template substitutions, literal and computed specifiers, import attributes, re-exports, import.meta, CommonJS, and ESM loaded through `require`. The browser smoke test also runs the first two fixtures in Chromium and WebKit.

A 2026-10-16 offline Next 15.5.6 replay combined this transform with the runtime fixes from PR 9 at `4e48b1ecb17fbc1a8d5edfa68305f0222500fe77`. The probe started from main `84dccd1`; its temporary integration head was `82ba601`. The delivery branch was then rebased to main `bf0a4a6` after the generated-builtins changes merged. Install passed. Build advanced beyond the import-method syntax error and stopped at `NotSupportedError: crypto.subtle.generateKey is not supported in bun-wasm`. Start remained blocked by build. Dev still returned no useful diagnostic. This is progress to another missing API, not a passing Next application.

The next owner should implement the Web Crypto operations Next needs. The current rejection comes from `crates/bunwasm-runtime/src/js/web.js:1277`, where `generateKey`, `importKey`, `exportKey`, encryption, and other operations are unsupported stubs. The SWC platform warning appeared before the failure but was not the terminating error. No additional crypto operation or algorithm was isolated in this run.

After building both changes, reproduce with a fresh output directory:

```sh
export PATH=$HOME/.local/share/mise/shims:$PATH
source env.sh
bash /work/tmp/wave-heavy/run.sh --class browser "Next browser import follow-up" -- \
  env PATH="$PATH" scripts/app-matrix.sh --apps=next --engines=browser \
  --hosts=native --timeout=90 \
  --output=/work/reports/bun-wasm-next-browser-import-follow-up
```

Evidence is retained in `/work/reports/bun-wasm-dynamic-import-2026-10-16/next-with-pr9/`. It includes the exact build error, all four stage records, artifact hashes, and an empty registry-miss list. The runner reported cleanup complete. The separate delivery-base replay under `next-after/` passed install, reported no useful diagnostic for dev or build, and blocked start on build. Both replays had no registry misses or errors and reported cleanup complete. The integration does not claim PR 9's earlier fixes shipped in this PR.

### Lazy stack review rerun on main

Both formatter timing and the non-idempotent source-map regression are fixed.
JSC captures raw frames and chooses the public formatter at first access;
successful arbitrary results are memoized, while formatter exceptions propagate
at access. Already-mapped CallSites keep the same locations when stringified.
QuickJS also defers public formatting for ordinary Error construction. JSC keeps
its native Error constructor.

The reviewed artifacts fail lazy capture on QuickJS and JSC, unread Error
construction on QuickJS, and mapped JSC CallSite strings. All three regression
fixtures pass on every engine after the fixes. The exact JSC reproducer now prints
`mapped location 15 10 outer (/mapped.ts:15:10)`; the reviewed binary printed 22:10
in the string while its getters reported 15:10.

After normal merges of main through 84db5fe, all 120 fixtures pass on each
engine. The complete web gate and all six built-site HMR runs pass. Express and
Koa pass all 12 native install/server stages, with no registry misses. There are
no playground rows defined for these server fixtures. Package sources and app
fixtures are unchanged.

| Engine | Reviewed Express/Koa stages | Current-main rerun |
| --- | --- | --- |
| QuickJS | 4/4 | 4/4 |
| JSC | 4/4 | 4/4 |
| Browser engine | 4/4 | 4/4 |

Median microseconds per unread construction, measured inside the runtime with
`scripts/bench/error-construction.js`. Each case warms up 1,000 operations, then
runs five samples of 10,000 operations with stackTraceLimit 10. Startup is excluded.

| Engine | Operation | Reviewed binary, µs | Current-main binary, µs |
| --- | --- | ---: | ---: |
| quickjs | new Error default | 10.187 | 1.790 |
| quickjs | capture default | 10.090 | 2.650 |
| quickjs | new Error custom | 10.481 | 1.704 |
| quickjs | capture custom | 10.681 | 2.827 |
| jsc | new Error default | 0.414 | 0.496 |
| jsc | capture default | 1.224 | 1.994 |
| jsc | new Error custom | 0.419 | 0.500 |
| jsc | capture custom | 27.049 | 1.979 |

Custom formatter counts fall from 50,000 to zero on QuickJS Error/capture and
JSC capture. JSC ordinary Error construction calls none in both versions and
keeps its native implementation. Default JSC capture adds a lazy accessor for
late formatter selection. The current-main measurements include the merged
Console and other runtime changes; the earlier isolated review-phase samples
are retained alongside them.

The same three upstream stack files retain 0/3 fully passing files, five failures,
one error and zero timeouts on every engine. Current artifacts, logs and exact
commands are in `/work/reports/bun-wasm-app-reviews-2026-10-16/main84/`.
The coordinator removes retained review evidence after both app-blocker PRs merge
and independent verification finishes.

### Frozen and reentrant stack review rerun

Lazy stack reads now cache successful values independently of the holder's
properties. Frozen and sealed holders retain their accessors. Capture rejects
non-extensible targets, including those with an existing configurable stack,
before mutating them. A successful recapture clears the prior cached value.

One formatter guard covers all errors, as V8's guard does. A reentrant read uses
the default stack and caches it privately until the outer formatter finishes.
This preserves the outer result even when the formatter freezes or seals its
holder after a self-read. Exceptions clear the guard. A self-read followed by an
exception preserves the default cache; an exception without a self-read permits
a later retry.

Node v26.7.0 passes all 22 behavior controls. The failing-first fixture commits
precede the implementation fixes. The reviewed binaries are from cd99cba.

| Engine | Frozen/non-extensible cases before | Reentrancy cases before | After |
| --- | --- | --- | --- |
| QuickJS | 8/14 | 1/8 | 22/22 |
| JSC | 5/14 | 2/8 | 22/22 |
| Browser engine | 14/14 | 8/8 | 22/22 |

After a normal merge of main through 7bb1c12, all 124 fixtures pass on each
engine. The complete web gate and all six built-site HMR runs pass. The unchanged
Express/Koa projects pass all 12 fresh-install and server stages, retaining 4/4
per engine from the reviewed binary. The offline registry has zero misses and
errors. No app fixture or package implementation was changed.

The same three upstream stack files retain 0/3 fully passing files, five failed
tests, one error and zero timeouts per engine, matching the reviewed binaries.

Construction controls still make zero public formatter calls in all four cases
on QuickJS and JSC. The same five-sample, 10,000-operation benchmark gives these
medians in microseconds per construction. This is one bounded run under shared
host load; the before artifact predates the merged generated-import changes.

| Engine | Operation | Reviewed binary, µs | Fixed binary, µs |
| --- | --- | ---: | ---: |
| quickjs | new Error default | 1.870 | 1.889 |
| quickjs | capture default | 2.689 | 3.027 |
| quickjs | new Error custom | 1.689 | 2.260 |
| quickjs | capture custom | 2.654 | 4.794 |
| jsc | new Error default | 0.465 | 0.495 |
| jsc | capture default | 2.804 | 2.159 |
| jsc | new Error custom | 0.496 | 0.485 |
| jsc | capture custom | 2.566 | 2.248 |

Artifacts and complete command logs are retained in
`/work/reports/bun-wasm-stack-round2-2026-10-16/`. Its `dist/` directory contains
`bun.wasm`, `bun-jsc.wasm` and `bun-browser.wasm`; `launcher` is the matching
native launcher. The coordinator removes this evidence after PR #11 merges and
independent verification finishes.

## Next.js runtime boundaries

A 2026-10-16 offline replay of Next 15.5.6 uses the unchanged published-package fixture. Fresh installs pass on QuickJS, JSC, and the browser-engine native host. Dev/build still fail and production start remains blocked. The counts are unchanged at 3 pass, 6 fail, and 3 blocked; the changes remove earlier runtime boundaries rather than establish app compatibility.

| Engine / host | Stage | Before | After |
| --- | --- | --- | --- |
| QuickJS / native | dev | `ReferenceError: module is not defined` | `ReferenceError: TextEncoderStream is not defined` |
| QuickJS / native | build | `ReferenceError: module is not defined` | `ReferenceError: TextEncoderStream is not defined` |
| QuickJS / native | start | Blocked by build | Blocked by build |
| JSC / native | dev | `ReferenceError: module is not defined` | `ReferenceError: TextEncoderStream is not defined` |
| JSC / native | build | `ReferenceError: module is not defined` | `ReferenceError: TextEncoderStream is not defined` |
| JSC / native | start | Blocked by build | Blocked by build |
| Browser engine / native | dev | Fails HTTP assertion without a diagnostic | Same observed failure |
| Browser engine / native | build | `Error: No such module: fs` | `SyntaxError: Unexpected token '.'` in `bloom-filter.js` |
| Browser engine / native | start | Blocked by build | Blocked by build |

The original module error came from a minified CommonJS module with `await` inside an async method. The loader treated any unindented line containing `await` as top-level await. It now uses Bun's parser syntax flags, import records, and CommonJS classification. Real `import.meta` takes priority over CommonJS hints in raw sources. Printed CommonJS factories receive the per-module metadata argument when Bun emits it. Syntax-free scripts retain package and filename classification; data loaders report their generated ESM format.

Next's bundled tar library probes `fs.writev`; its absence selected an unsupported private `process.binding("fs")` fallback. The public callback, synchronous, and FileHandle vectored-write APIs now use counted native writes. A short write or an error after earlier buffers returns the bytes actually written. Positioned writes preserve the descriptor cursor. Public vectored writes validate descriptor types, integers, and bounds before native conversion. The browser engine then reached a legacy `Stream.call(this)` constructor call; the base Node Stream constructor now supports that public subclass pattern.

The next measured QuickJS/JSC blocker is category d. Reproduce with `bun run node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3000` or `bun run node_modules/next/dist/bin/next build` after a normal install. Both report `ReferenceError: TextEncoderStream is not defined` in `node_modules/next/dist/compiled/@edge-runtime/primitives/load.js:18588` on QuickJS, or line 18592 on JSC, while loading `@edge-runtime/ponyfill`. That loader reads both `TextEncoderStream` and `TextDecoderStream`. The runtime supplies only a minimal `ReadableStream` at `crates/bunwasm-runtime/src/js/web.js:764`, with no `WritableStream` or `TransformStream`. Correct text streams require the larger Web Streams implementation, including state, cancellation, and backpressure.

The next measured browser-engine build blocker is also category d. Next's `dist/shared/lib/bloom-filter.js` declares an ordinary `import(data)` class method. `crates/bunwasm-runtime/src/engine_host.rs:455` treats its name as a dynamic-import expression. `host_dynamic_imports` at line 301 replaces the method name with `globalThis.__bunwasm_dynamicImport(...)`, producing an invalid method declaration. A diagnostic-only host copy identified the failing filename; the stock host reports the same syntax error. The earlier unsupported-SWC-platform line is a warning, not evidence for classifying this first blocker as a platform limitation.

The original [six-line reproducer](repros/import-method.cjs) prints `42` on QuickJS and fails to compile on the browser engine. Run it with `node --no-warnings web/scripts/node-host.mjs --wasm dist/bun-browser.wasm --dir "$PWD/docs/app-matrix/repros::/" -- run /import-method.cjs`. A follow-up must obtain semantic dynamic-import locations from Bun's parser/printer for both CommonJS and ESM, including nonliteral imports, and remove the lexical method/call ambiguity. Its tests must cover method names, member calls, multiline declarations, and automatic semicolon insertion. The Next follow-up owns moving this reproducer into a passing runtime fixture after the scanner fix.

Production start remains blocked because neither build has produced `.next/BUILD_ID`. The browser dev command's missing HTTP response and diagnostic are still unresolved; an IPC dependency in Next's source is not treated as a measured first blocker.

Evidence lives in `/work/reports/bun-wasm-next-2026-10-16/before/`, `after-delivery/`, and `browser-module-diagnostic/`. Replay with `scripts/app-matrix.sh --apps=next --engines=quickjs,jsc,browser --hosts=native --timeout=90 --output=<fresh-directory>`. The four selected upstream files retain 19 passed, 27 failed, 5 skipped, and 3 todo before and after, with one collection error. They are `cli/run/commonjs-no-export.test.ts`, `js/bun/resolve/require.test.ts`, `js/node/fs/promises.test.js`, and `js/node/stream/node-stream.test.js`.

The final runtime fixture gates pass 103/103 on each engine, including mixed CommonJS/import-meta sources, invalid vectored-write descriptors, and nine bounded short-write/cursor cases. The focused matrix review file passes all eight tests, including rejection-prefixed diagnostics. The two remaining build blockers above are retained as measured compatibility gaps.

The PR #9 review replay on 2026-10-16, after the import-metadata, partial-write, and descriptor-validation fixes, retains the same Next rows on all three engines. Install/dev/build/start remain pass/fail/fail/blocked per engine, with the same diagnostics listed above. The offline mirror had zero misses and errors, and the runner confirmed cleanup. Review evidence is retained at `/work/reports/bun-wasm-next-review-2026-10-16/next-after/`.

## Rollup distribution rerun, 2026-10-16

Fresh installs now select Rollup 4's unchanged official `@rollup/wasm-node`
distribution at the exact selected version. QuickJS and JSC execute its wasm
through the shared Rust interpreter adapter. The browser engine uses native
WebAssembly. The installed files and package identity stay unchanged, and
projects keep their existing `rollup` dependency names and imports. See
[the installer policy](../install.md#webassembly-distributions).

The offline rerun covers all six affected projects on all three engines. The
fixture hash is unchanged. Each run has 18 install passes and 30 command
failures. The first blocker changed in every command. These apps still do not
pass their complete workflows. The published Rollup parser, Unicode and syntax
errors, three hash exports, a complete bundle generation, and frozen reinstall pass on all three
engines in `bun tests/rollup/run.mjs`.

| Projects and commands | Before, every engine | After, QuickJS and JSC | After, browser engine |
| --- | --- | --- | --- |
| Vite vanilla, React, Vue; dev and build | Native Rollup rejects wasm32 | Missing Bun `ws` builtin | Linker rewrites an `import` method into invalid syntax |
| Astro; build | Native Rollup rejects wasm32 | Missing Bun `ws` builtin | Same linker syntax error |
| SvelteKit; dev and build | Native Rollup rejects wasm32 | Missing Bun `ws` builtin | Same linker syntax error |
| Vitest; test | Native Rollup rejects wasm32 | Missing `node:console.Console` export | Same linker syntax error |

The playground rerun adds three install passes and six command failures for
Vite React. Its QuickJS and JSC commands now reach `ws`; its browser-engine
commands reach the linker syntax error. The original 2026-10-15 playground
census had six Rollup platform errors for these commands; the rerun has zero.

[Per-command results](rollup-results.md) retain the observed diagnostics and
run-time categories. The classifier conservatively labels the new blockers d;
the method-declaration diagnosis below was established after the census. The raw before/after records are in
`/work/reports/bun-wasm-rollup/{before,after}/`. The unchanged upstream installer
subset has 113 files, 233 observed passes, 4,203 failures, 83 skips, 22 todos, 42
errors, and zero timeouts before and after this change. The baseline predates
the semver host-function merge; the final run includes it.

Reproduce the remaining blockers with the same offline matrix:

```sh
source env.sh
scripts/app-matrix.sh --apps=vite-vanilla,vite-react,vite-vue,astro,sveltekit,vitest \
  --engines=quickjs,jsc,browser --hosts=native \
  --output=/work/reports/bun-wasm-rollup/new-run
```

Run that command through the machine's heavy wrapper, as above. The next fixes
are separate runtime API and module-linker work:

- Vite 7.1.12's `dist/node/chunks/config.js:23728` selects
  `process.versions.bun ? import.meta.require("ws").WebSocketServer : ...`.
  `bun run node_modules/vite/bin/vite.js build` reports
  `Cannot find package 'ws' from '/node_modules/vite/dist/node/chunks/config.js'`.
  Astro reaches the same branch in its own Vite chunk. `ws` is a Vite development
  dependency, not a missing published runtime dependency. Bun supplies it as a
  builtin. The runtime registry in `crates/bunwasm-runtime/src/resolve.rs:40`
  has no `ws`; the upstream adapter is `vendor/bun/src/js/thirdparty/ws.js`.
  It needs the WebSocket server boundary, not an installer dependency injection.
- `bun run node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism`
  reports `Could not find export 'Console' in module 'node:console'` on QuickJS
  and the corresponding missing-export message on JSC.
  `crates/bunwasm-runtime/src/js/builtins.js:1064` currently returns the console
  singleton; `src/js/console.js` has no `Console` constructor.
- The browser-engine command reports `SyntaxError: Unexpected token '.'`.
  A syntax-checking diagnostic identified Vite 7.1.12's
  `dist/node/module-runner.js:989`, `async import(url) { ... }`.
  The emitted module has
  `async globalThis.__bunwasm_dynamicImport("/node_modules/vite/dist/node/module-runner.js")(url) {`.
  `crates/bunwasm-runtime/src/engine_host.rs:450` treats the method declaration
  as a dynamic import, and `web/src/engine-host.js:545` substitutes the helper.
  A two-line reproduction, independent of any installed package, is:

  ```js
  class Loader { async import(url) { return url; } }
  console.log(await new Loader().import('ok'));
  ```

  Save it as `index.mjs` in a preopened directory and run
  `node --no-warnings web/scripts/node-host.mjs --wasm dist/bun-browser.wasm --dir <directory>::/ --env PWD=/ -- run /index.mjs`.
  The expected output is `ok`. The browser host reports the same syntax error.
  Retained diagnostics and the minimal source are in
  `/work/reports/bun-wasm-rollup/browser-diagnostic/`.

## Console and Vitest rerun, 2026-10-16

`node:console` now exports Bun's own `Console` constructor from
`src/js/builtins/ConsoleObject.ts`. It supports positional and options-object
construction, independent stdout/stderr streams, bound methods, color mode,
inspect options, group indentation, counters, timers, tracing, and tables.
`console.Console` is the same export. The global singleton retains its Bun
formatter. The generated factory and original adapter run on all three engines;
[the builtin notes](../bun-builtins.md#console-constructor) explain why this
global-object builtin is loaded separately from Bun's module registry.

The offline Vitest 3.2.4 fixture still installs on every engine. Its complete
test command still fails, with these first blockers:

| Engine | Before | After |
| --- | --- | --- |
| QuickJS | Missing `node:console.Console` export | `Cannot find package 'ws' from '/node_modules/vite/dist/node/chunks/config.js'` |
| JSC | Missing `node:console.Console` export | Same missing `ws` builtin |
| Browser engine | Import-method linker syntax error | Same linker error, `SyntaxError: Unexpected token '.'` |

QuickJS and JSC now reach the same Vite builtin boundary described in the
[Rollup rerun](#rollup-distribution-rerun-2026-10-16). Vite 7.3.7's `dist/node/chunks/config.js:20578`
selects `import.meta.require("ws").WebSocketServer` when `process.versions.bun`
is set. This requires the real Bun WebSocket server adapter and is assigned to
the separate WebSocket track. No package was injected into the app fixture to
hide that missing builtin. PR #13 addresses the browser linker independently.

The unchanged upstream `test/js/node/console/` slice contains three files.
All engines start at zero fully passing files, zero passing tests, three failed
tests, one collection error, and zero timeouts.

| Engine | Fully passing files after | Passing tests | Failed tests | Collection errors | Timeouts |
| --- | ---: | ---: | ---: | ---: | ---: |
| QuickJS | 2/3 | 8 | 1 | 0 | 0 |
| JSC | 3/3 | 9 | 0 | 0 | 0 |
| Browser engine | 3/3 | 9 | 0 | 0 | 0 |

QuickJS's unchanged failure is the recursive child in
`console-constructor-exception.test.ts`. It traps with `wasm trap: call stack
exhausted` before JavaScript can catch a RangeError. Both the original runtime
and the Console runtime exhibit the same trap. The
[stack follow-up](../../plans/compatibility-followups.md#quickjs-recursion-traps-before-javascript-can-catch-the-error)
records the command, backtrace, and engine policy to investigate. The new local
fixtures pass on every engine, including asynchronous stream callbacks and the
Writable destroy hook used by the upstream tests.

Reproduce each engine's upstream slice and the app row through the heavy wrapper:

```sh
source env.sh
scripts/bun-suite.sh --engine quickjs --network loopback --jobs 1 \
  --launcher "$CARGO_TARGET_DIR/release/bun-wasm" \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /work/tmp/bun-wasm-console-upstream.json js/node/console
scripts/app-matrix.sh --apps=vitest --engines=quickjs,jsc,browser --hosts=native \
  --output=/work/tmp/bun-wasm-console-vitest
```

Use fresh output paths, and substitute `jsc` or `browser` for the suite comparison.
Raw records are retained in `/work/reports/bun-wasm-console/`, including
`console-{before,after}-<engine>.json` and `vitest-{before,after}/`.
The before artifacts embed the original main JavaScript through the build-time
override directory. Before and after use the same vendor checkout and launcher;
their hashes are recorded by both runners. The fixture and registry cache are
unchanged between app runs, with no missing replay objects.

The final rebased build passes all 108 local fixtures on QuickJS, JSC, and the
browser engine. The web checks, site build, and all six Chromium/WebKit HMR
runs pass. The final upstream console and Vitest reruns retain the counts and
first blockers above. The local fixtures also check FORCE_COLOR against
explicit color modes, preserve stderr trace messages, and exercise asynchronous
write errors without leaking stdio error listeners. Native Bun 1.4.2 drops a
Console trace's message; the Node-contract fixture is marked manual, and a
minimal Bun/Node comparison is recorded in the owner's upstream bug report.

The [esbuild follow-up measurement](esbuild-results.md) records the five requested
framework projects after selecting the official wasm distribution, including
passing production builds and the exact next blockers.

## Generated-function import review rerun

The adapter now uses Bun's full parser to locate genuine import keywords in
original constructor arguments, then converts their byte positions to UTF-16
indices. Native constructor validation runs before rewriting. Templates,
comments, import-named methods and the original argument text stay intact.
A function literal accesses an intrinsic-prototype helper without looking up a
user identifier, so local or parameter bindings named globalThis and with scopes
cannot capture it. Specifier conversion runs once inside an async helper and
rejects Symbols with TypeError while preserving falsy rejection reasons.

The failing-first review fixture runs from a nested creating module. It covers
comment and template imports across Function, AsyncFunction, GeneratorFunction
and AsyncGeneratorFunction, awaited templates, three shadowing forms, Symbol
rejection, one coercion and falsy thrown values.

| Engine | Reviewed regression cases | Revised cases |
| --- | --- | --- |
| QuickJS | 2/15 | 15/15 |
| JSC | 15/15 | 15/15 |
| Browser engine | 2/15 | 15/15 |

After normal merges of main through 84db5fe, all 117 fixtures pass on every
engine. The complete web gate and all six built-site HMR runs pass. The unchanged
published Prettier 3.6.2 fixture passes fresh installation and its normal CLI check
on native and playground hosts, with no registry misses.

| Engine | Reviewed app stages, both hosts | Current-main stages |
| --- | --- | --- |
| QuickJS | 4/4 | 4/4 |
| JSC | 4/4 | 4/4 |
| Browser engine | 4/4 | 4/4 |

Both targeted dynamic-import upstream files pass on every engine, retaining 2/3
fully passing files in the three-file selection. The broad concurrent Node
module file does not complete and retains unsupported module API cases.

| Engine | Reviewed observed pass/fail/skip | Current observed pass/fail/skip | File timeouts, before/after |
| --- | --- | --- | --- |
| QuickJS | 5/18/1 | 5/18/1 | 1/1 |
| JSC | 5/17/1 | 5/18/1 | 0/0 |
| Browser engine | 2/13/1 | 2/13/1 | 0/1 |

The current JSC run additionally observed `module.Module works` before aborting;
that failure is also present in the reviewed QuickJS control. The browser run
has the same observed counts but reaches the wall timeout in the broad file.
These incomplete-file counts are recorded separately from the passing import
files. Commands and per-file results are in
`/work/reports/bun-wasm-app-reviews-2026-10-16/main84/`.
The coordinator removes retained review artifacts after both app-blocker PRs merge
and independent verification finishes.

### Web Streams round-3 replay with semantic imports

The round-3 replay includes main's semantic import linking from PR #13. It uses
runtime artifacts built at `400a264`; the replay revision `fbb9a81` adds only
follow-up documentation. Next 15.5.6 has 3 passing installs, 6 failed commands
and 3 blocked starts. The offline registry serves 213 requests with no misses
or errors, and the runner reports cleanup complete.

QuickJS and JSC dev stop at `LinkError: Unsupported WebAssembly export table`
while loading llhttp. Their builds exit without a useful diagnostic. Browser
build advances to `NotSupportedError: crypto.subtle.generateKey is not supported
in bun-wasm`; browser dev still has no useful diagnostic. These are separate
observations. No missing Streams global appears and no passing Next app is
claimed. Main's WASI-host changes from PR #24 are integrated afterward and get
separate host verification.

Reproduce with `scripts/app-matrix.sh --apps=next
--engines=quickjs,jsc,browser --hosts=native --timeout=90 --output=<fresh-output>`,
using the built native launcher and the heavy wrapper. Exact artifacts, all
stage records, raw output and registry provenance are in
`/work/reports/bun-wasm-streams-round3-fix-2026-10-16/next-final/`. The coordinator
owns the retained evidence until independent review and follow-up reproduction.

## Next opendir rerun

The review rerun on 2026-10-16 uses main through `12307c3`, the pending Web Streams
and WebCrypto branches, and the directory fixes. The semantic import rewrite is
already on main. All three integration binaries were rebuilt for each side.
The before side substitutes main's filesystem factory; the after side exposes the
new directory API. Both sides use the same Next 15.5.6, React 19.1.1 and React DOM
19.1.1 fixture and offline registry snapshot.

| Engine | Before | After |
| --- | --- | --- |
| QuickJS | install passes; dev and build fail with `LinkError: Unsupported WebAssembly export table`; start blocked | same result |
| JSC | install passes; dev and build fail with `LinkError: Unsupported WebAssembly export table`; start blocked | same result |
| Browser | install passes; dev fails without a diagnostic; build fails with `TypeError: _promises.default.opendir is not a function`; start blocked | install passes; dev fails without a diagnostic; build reaches production compilation and fails with `Error: Child process IPC is not supported in bun-wasm`; start blocked |

Each side records 12 stages, with three installation passes, six command failures
and three blocked starts. No stage times out. The raw build logs contain the errors
above even where the automatic classifier reports no diagnostic.

Reproduce the row after building the local integration:

```sh
scripts/app-matrix.sh --apps=next --hosts=native --engines=quickjs,jsc,browser \
  --launcher="$CARGO_TARGET_DIR/release/bun-wasm" --timeout=60 \
  --output=/work/reports/bun-wasm-next-opendir-replay
```

The dev command is `bun run node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port <free-port>`.
The build command is `bun run node_modules/next/dist/bin/next build`.
QuickJS and JSC reject the llhttp wasm table export at
`crates/bunwasm-runtime/src/js/webassembly.js:136`; the Next caller is
`node_modules/next/dist/compiled/@edge-runtime/primitives/load.js:5630`.
Browser build reaches `ChildProcess.send` at `crates/bunwasm-runtime/src/js/spawn.js:411`.
Both require broader runtime work and are recorded in
[compatibility follow-ups](../../plans/compatibility-followups.md#next-after-directory-handles).
Browser dev still exits without a useful diagnostic, so no source location is established.

The directory review regressions fail with the reviewed factory on every engine
and pass with the correction. All 139 fixtures pass on each engine, the web gate
passes, and all six HMR runs pass. Nine independent WASI host observations verify
GC descriptor release before exit and cleanup after natural and explicit exit,
including a retained wasm instance. Node 26.7.0 passes all four contract controls.
The upstream directory file remains at 21 pass and two fail per engine. Its two
failures expect synchronous throws from closed no-argument promise calls; Node
rejects those promises instead.

Fresh logs, source hashes, the integration-only standalone-example linker recipe,
and the before/after result files are in
`/work/reports/bun-wasm-rv28-final-20261016/`. The integration was pinned to
`43d10f4e84997a51d07f8892ad72e739c2548fc3`; the only measurement-side filesystem
change is recorded in `integration-before-fs.sha256`. Both runs report cleanup
complete and zero registry misses or errors. The coordinator removes this review
evidence after accepting the PR and finishing independent verification.

### Directory hard-exit review

The second directory review adds retained-instance checks for browser-host
`process.reallyExit`, abort and self-kill. With the reviewed host implementation,
each leaves ten native cursors and ten WASI descriptors open. `EngineHost.exit`
now releases the table before notifying the host, and all 13 host observations
pass. After exit, the same retained instance can open and close a directory using
a released descriptor. Ordinary fatal-error handling remains a control that runs
its exit listeners; hard exits continue to skip them.

The browser-engine GC observations use Node/V8 with `--expose-gc`. Real browser
workers have no forced-GC hook. The Chromium/WebKit web and HMR gates are separate
checks of browser behavior, not evidence of forced collection in those workers.
The second-review red/green logs are retained in
`/work/reports/bun-wasm-rv28-round2-20261016/`.

## Framework exit provenance

[Framework exits and Vite reloads](exit-provenance.md) traces the shared `ws`
lookup failure, Vite's stdin-triggered exit and the new runtime exit records.
Native Vite dev checks also edit the source and verify the browser update.

<!-- replay:start -->
## Current full replay after mirror recording

The recording and corrected offline replay have zero registry misses and zero registry errors. Counts below exclude the recording's native Bun controls.

| App | Pass | Fail | Blocked | First blocker |
| --- | --- | --- | --- | --- |
| astro | 3 | 3 | 0 | quickjs/native/build: build: No diagnostic before exit or deadline |
| drizzle | 12 | 0 | 0 | - |
| elysia | 6 | 0 | 0 | - |
| eslint | 18 | 0 | 0 | - |
| express | 6 | 0 | 0 | - |
| fastify | 6 | 0 | 0 | - |
| hono | 12 | 0 | 0 | - |
| koa | 6 | 0 | 0 | - |
| next | 3 | 6 | 3 | quickjs/native/dev: server: LinkError: Unsupported WebAssembly export table |
| prettier | 12 | 0 | 0 | - |
| prisma | 0 | 3 | 9 | quickjs/native/install: install: memory allocation of 16770432 bytes failed |
| sveltekit | 3 | 6 | 0 | quickjs/native/dev: server: No diagnostic before exit or deadline |
| typescript | 18 | 0 | 0 | - |
| vite-react | 6 | 12 | 0 | quickjs/native/dev: server: No diagnostic before exit or deadline |
| vite-vanilla | 3 | 6 | 0 | quickjs/native/dev: server: No diagnostic before exit or deadline |
| vite-vue | 3 | 6 | 0 | quickjs/native/dev: server: No diagnostic before exit or deadline |
| vitest | 3 | 6 | 0 | quickjs/native/test: test: No diagnostic before exit or deadline |
| Overall | 120 | 48 | 12 | - |

| Engine | Host | Pass | Fail | Blocked |
| --- | --- | --- | --- | --- |
| quickjs | native | 27 | 14 | 4 |
| quickjs | playground | 13 | 2 | 0 |
| jsc | native | 27 | 14 | 4 |
| jsc | playground | 13 | 2 | 0 |
| browser | native | 27 | 14 | 4 |
| browser | playground | 13 | 2 | 0 |

| Scope | Before recording | Corrected offline replay |
| --- | --- | --- |
| native | 63 pass / 27 fail / 45 blocked | 81 pass / 42 fail / 12 blocked |
| playground | 36 pass / 3 fail / 6 blocked | 39 pass / 6 fail / 0 blocked |
| All stages | 99 pass / 30 fail / 51 blocked | 120 pass / 48 fail / 12 blocked |

The original replay had 51 blocked stages. Of those, 39 were blocked by missing esbuild-wasm records. The corrected replay has 12 prerequisite blocks, from Next builds and Prisma installs. Missing diagnostics identify an unresolved failure, not a proven cause.

### Provenance

These tables are generated from the committed raw JSON snapshots. Each snapshot is byte-identical to the retained results.json. The suite artifacts were built at runtime commit `6e93c80c6f9bccc879990bedb999c3efdcd3166f`. The app snapshots record their checkout revisions below, including the docs-only checkout `ec213e8ee326336f31feea9ef5763e793b9e2d60` used for the corrected replay. App artifact hashes changed between replays. These runs establish app outcomes for the recorded artifacts, not an isolated runtime before/after improvement.

| Snapshot | Recorded checkout revision | Raw JSON SHA-256 |
| --- | --- | --- |
| before.json | 6e93c80c6f9bccc879990bedb999c3efdcd3166f | 1a9f9747c62d03859ca8b968ce81c361f723c75bd2eeb360b1819b58507a652f |
| recording.json | ec213e8ee326336f31feea9ef5763e793b9e2d60 | 74a4a5d823b4bdef8643c95ead958963c1b829a6dd801bc1b5d3c7c3d030b4c0 |
| after.json | ec213e8ee326336f31feea9ef5763e793b9e2d60 | 6b203e01cdb2c202f6fb04ec056fc1175120d07b34e79f9571de53b90aed4313 |

| Engine | Original replay wasm SHA-256 | Corrected replay wasm SHA-256 |
| --- | --- | --- |
| quickjs | 794e4b24f5755f4f18d2e2aac5149d87de73f7d7f2c27fba2d0fdf8ff7ec82c9 | 639050a0c57a032bba6faf902ccd0cc10b6baff070428b1503832f5aa34df32c |
| jsc | 596e8f29bfd9d48c556b1f9a26ca9e8b9e439a4d8351551718cb13cbefe7b36f | 5fe717047ff801443f9cbbebc6e62b72bc443a608235879269deac1c9b94bfb3 |
| browser | accc747792ac2e53e4ea86e51b15c3f3ec5354e20516288d95a79aae7cea7e0e | 4bc3f2754a9bfc59c613f36c5c4009cf345e5a46455453227ce67423b65d81f6 |

Corrected registry digest: `5428da1454a78fbfa8dc868114365c5a448fc2ad2556b2977caa17520890a7d2`.

Regenerate or check every table in this section, and the suite headline and progress tables, with:

```sh
bun scripts/refresh-compatibility-docs.ts
bun scripts/refresh-compatibility-docs.ts --check
```
<!-- replay:end -->

Recording command:

```sh
scripts/app-matrix.sh --record --reference --apps=vite-vanilla,vite-react,vite-vue,astro,sveltekit,vitest --engines=quickjs,jsc,browser --hosts=native,playground --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/app-matrix-record --timeout=90 --launcher=/work/reports/bun-wasm-main-2026-10-17/bun-wasm-launcher
```

Offline replay command:

```sh
scripts/app-matrix.sh --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-main-2026-10-17/app-matrix-after-record --timeout=90 --launcher=/work/reports/bun-wasm-main-2026-10-17/bun-wasm-launcher
```

Raw records and logs are retained in `/work/reports/bun-wasm-main-2026-10-17/app-matrix-record/` and `/work/reports/bun-wasm-main-2026-10-17/app-matrix-after-record/`. The suite cause ranking is in [`docs/bun-test-suite/triage.md`](../bun-test-suite/triage.md#ranked-next-fixes).
