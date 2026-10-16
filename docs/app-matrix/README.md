# Real app compatibility

This matrix measures complete app commands after a fresh `bun install` in bun-wasm. It covers 17 pinned projects. QuickJS and JSC use the native launcher and real loopback HTTP. The browser-engine native row uses Node's engine host with the same wasm runtime, not native Bun. Hono, Vite React, Drizzle, Prettier, TypeScript, and ESLint also run inside the playground in headless Chromium, across all three engines.

The fixtures are original minimal projects that import the real published packages. No package implementation is replaced. Vite React uses React's public `createElement` API, and Vite Vue uses Vue's `h` API. SvelteKit uses the static adapter. These projects avoid template generators and their moving defaults.

Commands invoke installed JavaScript entry points with `bun run`. The installer does not yet create package binaries in `node_modules/.bin`, so a shorthand such as `bun run dev` would measure that installer gap for every tool. Each recorded command still runs the package's actual CLI. Install failures stop execution; dependent commands are `blocked`, never counted as tested failures or passes. Next production start additionally depends on its build passing.

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

## Next fixes

These priorities count app projects, not individual command rows.

1. Fix the browser module linker recognizing `import` methods as dynamic-import calls, and implement Bun's `ws` builtin for Vite. The [Rollup rerun](#rollup-distribution-rerun-2026-10-16) records the remaining diagnostics for the six affected projects.
2. Complete Web Streams and replace ambiguous dynamic-import scanning for Next.js. Its earlier CommonJS, vectored-write, and legacy Stream-constructor boundaries are fixed; dev/build/start are still failing or blocked.
3. Fix QuickJS and JSC stack call-site access for Express and Koa. This unblocks two server projects on two engines.
4. Add the missing CLI module resolution used by Prettier in QuickJS and the browser engine.
5. Make Prisma's native-engine limitation explicit in the app fixture and add a WASM engine policy if the upstream package provides one.


Rank remaining causes by the number of distinct app projects they would unblock, rather than counting install, dev, and build rows as separate apps. An install or module-loading fix exposes the next blocker; it does not promise that the app will then pass.

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
[Rollup rerun](#rollup-distribution-rerun-2026-10-16). Vite's config module
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
