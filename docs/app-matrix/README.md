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

## Generated CLI import rerun

Prettier 3.6.2 now completes its normal CLI check after a fresh install of the
published package. All six install and check stages pass on the native host,
and all six pass in the playground. No package source or fixture was changed.

| Host | Engine | Before check | After check |
| --- | --- | --- | --- |
| Native | QuickJS | Fail, legacy-cli.mjs resolved from <input> | Pass |
| Native | JSC | Pass | Pass |
| Native | Browser | Fail, legacy-cli.mjs resolved from engine host | Pass |
| Playground | QuickJS | Fail, legacy-cli.mjs resolved from <input> | Pass |
| Playground | JSC | Pass | Pass |
| Playground | Browser | Fail, missing CLI success output | Pass |

The CLI creates its dynamic importer with the Function constructor. QuickJS
and the browser host lost the creating module's location at that boundary.
Generated functions now use the shared runtime resolver with the creating
module's origin. Native constructor parsing selects valid import replacements,
keeps methods named import intact, and preserves syntax errors. JSC retains its
native constructors. The selection also exposed a QuickJS data conversion bug.
A buffer type probe left a pending exception for ordinary arrays and objects;
the bridge now checks buffer class tags before calling the throwing getter.

All 93 fixtures pass on each engine on the revised caller-origin base. The bounded
upstream selection is unchanged before and after. Two of three files fully pass
on each engine. QuickJS records 5 observed passes, 18 failures, 1 skip and 1 file
timeout; JSC records 5 passes, 17 failures, 1 skip and no timeout; the browser
engine records 2 passes, 13 failures, 1 skip and no timeout. The two dynamic-import
files pass; the broad Node module test retains its existing failures.

```sh
source env.sh
bash /work/tmp/wave-heavy/run.sh --class light "Prettier native" -- \
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
including `before-native/`, `after-cli-resumed-native/`,
`after-cli-resumed-playground/` and `cli-suite-resumed-*.json`. The playground
baseline is the original `playground-light/` census under the 2026-10-15 report.

## Next fixes

These priorities count app projects, not individual command rows.

1. Replace or port the Rollup native package path with `@rollup/wasm-node`. This unblocks Vite vanilla, React, and Vue, Astro, SvelteKit, and Vitest build stages across all three engines.
2. Implement the missing module and Node API boundaries used by Next.js. This unblocks its dev, build, and start stages.
3. Fix QuickJS and JSC stack call-site access for Express and Koa. This unblocks two server projects on two engines.
4. Completed. Prettier passes on all three engines in the [generated CLI rerun](#generated-cli-import-rerun).
5. Make Prisma's native-engine limitation explicit in the app fixture and add a WASM engine policy if the upstream package provides one.


Rank remaining causes by the number of distinct app projects they would unblock, rather than counting install, dev, and build rows as separate apps. An install or module-loading fix exposes the next blocker; it does not promise that the app will then pass.
