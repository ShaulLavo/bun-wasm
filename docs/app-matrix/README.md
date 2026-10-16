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
2. Implement the missing module and Node API boundaries used by Next.js. This unblocks its dev, build, and start stages.
3. Fix QuickJS and JSC stack call-site access for Express and Koa. This unblocks two server projects on two engines.
4. Add the missing CLI module resolution used by Prettier in QuickJS and the browser engine.
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
