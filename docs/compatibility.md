# Compatibility

What runs, what fails, and how each number was measured. Every figure on this page comes from a recorded run with its date and revision.

Three test sets measure compatibility:

- The framework matrix runs 13 framework starters in four browsers on four engines, from `bun install` through a production build and preview. On 2026-11-23, all 208 combinations passed, with iPhone Safari running in the iOS 26.5 simulator.
- The server and tool app matrix runs 17 real projects under the native launcher, headless Node host, and headless Chromium. It was last run on 2026-10-17, and its raw records live in [`docs/app-matrix/`](app-matrix/README.md).
- Bun's own upstream test suite runs 2,305 upstream test files against each engine. The last full run was on 2026-10-17, and its raw records live in [`docs/bun-test-suite/`](bun-test-suite/README.md).

## Bun commands

`crates/bunwasm-cli/src/main.rs` dispatches these commands.

| Command | Status |
| --- | --- |
| `bun run <file>`, `bun <file>`, `bun run <script>` | Supported. Bun's transpiler loads TypeScript, TSX, JSX and TOML. |
| `bun -e <code>`, `bun -p <code>` | Supported. |
| `bun test` | Supported. See [Bun upstream test suite](#bun-upstream-test-suite). |
| `bun build`, `Bun.build` | Supported through Bun's bundler. |
| `bun install`, `bun i`, `bun ci`, `bun add`, `bun remove`, `bun update`, `bun x`, `bun pm` | Supported when the host supplies network access. See [Installing npm packages](install.md). |
| `bun lint`, `bun fmt` | Run in a separate guest, `bun-tools.wasm`. Without that file, the playground warns that lint and fmt are unavailable. |
| `bun exec <script>`, `Bun.$` | Supported. Both run through `/bin/sh` or `/bin/bash`, supplied by bash-web's `installShellCommands`. |
| `bun init` | Supported for the blank and minimal templates. With no template picker, it always takes Blank; `--react` is not supported. |
| `bun create <template>` | Supported for npm `create-<template>` packages such as `bun create vite`. GitHub and local templates are not supported. |
| `bun repl` | Supported for piped input only. Interactive terminal input from bash-web does not reach Bun yet. |
| `bun upgrade`, `link`, `unlink`, `outdated`, `publish`, `patch`, `patch-commit`, `info`, `why`, `audit`, `completions`, `getcompletes`, `discord`, `dedupe`, `prune`, `check`, `deploy`, `cloud`, `config`, `use`, `auth`, `login`, `logout` | Not supported. Each prints `error: bun <command> is not supported in bun-wasm` and exits 1. |

## Engines

One runtime runs on four JavaScript engines behind the `Engine` trait. QuickJS, JavaScriptCore and SpiderMonkey ship as a Bun core module plus an engine side module that links into the core's memory at load time. The `browser` engine ships as a single Wasm module and runs JavaScript on the worker's own engine outside Wasm.

The sizes below are uncompressed split-profile totals for core plus engine module, as the playground reported them in Chrome on 2026-11-23.

| Engine | JavaScript runs on | Modules | Uncompressed split-profile total |
| --- | --- | --- | ---: |
| `browser`, default in browsers | Host engine with JIT, V8 in Chrome, SpiderMonkey in Firefox, JavaScriptCore in Safari | `bun-browser.wasm` | 15.5 MiB |
| `quickjs` | QuickJS-ng inside Wasm | `bun.wasm`, `quickjs.wasm` | 18.1 MiB |
| `jsc` | JavaScriptCore inside Wasm, interpreter only | `bun-jsc.wasm`, `jsc-engine.wasm` | 49.1 MiB at `587c2c69c`, 49.3 MiB at `3b84f36a3` |
| `spidermonkey`, experimental opt-in | SpiderMonkey inside Wasm, interpreter | `bun-spidermonkey.wasm`, `spidermonkey-engine.wasm` | 27.0 MiB |

Shared-group profile builds in that same Chrome run measured 19.1 MiB for QuickJS, 48.0 MiB for JSC, and 28.0 MiB for SpiderMonkey. Over the wire with Brotli compression at `3b84f36a3`, the split-profile downloads are 4.6 MiB for `browser`, 5.3 MiB for `quickjs`, 11.9 MiB for `jsc`, and 6.9 MiB for `spidermonkey`.

The native Wasmtime launcher runs only the in-Wasm engines. The `browser` engine needs a host with its own JavaScript engine, either a browser worker or the headless Node host. The package registers SpiderMonkey only when you ask for it; see [SpiderMonkey host integration](spidermonkey-host-plumbing.md).

Because the `browser` engine runs on a standard JS engine without engine internals hooks, it differs from the in-Wasm engines in these ways; see [The browser engine](engine-browser.md#what-is-inherently-different):

| Behavior | `browser` engine |
| --- | --- |
| Promise state | Known only when the host observes settlement. Other promises print as `<pending>`, and `Bun.peek` returns them unchanged. |
| `AsyncLocalStorage` across `await` | Carried by transpiler hooks. Code that skips preparation can lose context. |
| `require()` of an ES module | Runs a converted CommonJS copy, separate from the ES module instance when the same file is also imported. |
| Import cycles | Work with or without a service worker, with live bindings and hoisted functions. |
| `Function.prototype.toString` of module code | Keeps names and structure, though formatting, comments and literal spelling can differ from the source file. |
| `process.memoryUsage()` | Reads `performance.memory` where Chromium exposes it, else zeros. |
| Raw `err.stack` strings | Follow the host engine's format. Formatted output from uncaught errors, `console.log(err)` and `bun test` matches the other engines. |

Hermes remains withdrawn from normal publication. In the retained Hermes revision `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065`, `Object.isSealed` and `Object.isFrozen` return false for sealed or frozen objects wrapped in an empty-handler Proxy. This known engine limitation has no workaround and does not affect the supported Browser engines. See [Dormant Hermes source](hermes-engine.md#known-engine-limitation).

## Frameworks in the browser

The framework matrix opens the sandbox in a real browser, picks a starter and an engine, and exercises the full edit-and-build loop. A combination passes only when all nine phases pass:

1. Startup: the guest loads and reports the selected engine.
2. Install: `bun install` exits 0.
3. Dev: the framework's dev server starts and exposes a preview URL.
4. Render: the preview shows the starter's expected text.
5. Click: a trusted click moves the counter from 0 to 1.
6. File update: saving an edited source file updates the preview automatically with no manual navigation. Ten frameworks update the existing document in place with counter state preserved. Astro, Angular and Qwik pass through automatic document replacement across all 48 of their cells.
7. Build: the production build exits 0.
8. Preview: the built app serves, renders, and increments its counter on a click.
9. Cleanup: the dev process and preview stop and the browser closes.

All 208 combinations passed on 2026-11-23, with every guest reporting Bun 1.4.4. Hang caps were 300 seconds for startup, dev, render, click, file update and preview, 600 seconds for install and build, and 60 seconds for cleanup. Those caps catch hangs and say nothing about speed.

The 208 passing cells came from four merged or since-merged builds on that day:

- 146 cells ran host and guest from main `587c2c69c`.
- 52 desktop Safari cells ran the `3b84f36a3` host and guest under controller `46897062e`.
- 2 Next.js JSC cells, one on Chrome and one on iPhone Safari, ran host, guest and controller from main `3b84f36a3`.
- 8 iPhone Safari cells ran the `587c2c69c` guest on host `35fb2162a`, which carried the iPhone memory-cap changes from PRs 1052 and 1056, both since merged to main.

| Framework | Starter version | Template directory under `sandbox/` |
| --- | --- | --- |
| Next.js | 15.5.6 | `template-next` |
| Nuxt | 3.19.3 | `template-nuxt` |
| SvelteKit | 2.43.1 | `template-sveltekit` |
| Astro | 5.14.1 | `template-astro` |
| React Router | 7.9.4 | `template-react-router` |
| SolidStart | 1.3.2 | `template-solidstart` |
| TanStack Start | 1.131.2 | `template-tanstack-start` |
| Angular | 20.3.7 | `template-angular` |
| Qwik | 1.17.2 | `template-qwik` |
| Vite with React | Vite 8.3.5, React 19.3.1 | `template` |
| Vite with Vue | Vite 7.1.12, Vue 3.5.22 | `template-vite-vue` |
| Vite with Svelte | Vite 7.1.12, Svelte 5.39.11 | `template-vite-svelte` |
| Hono server | 4.10.2 | `template-hono` |

Every framework passes in every cell of this grid:

| Browser | Environment | `browser` | `quickjs` | `jsc` | `spidermonkey` |
| --- | --- | --- | --- | --- | --- |
| Chrome 157 | Linux PC, headless | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |
| Firefox 157 | Linux PC, Playwright Firefox | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |
| Safari 26.4 | macOS, native Safari via safaridriver | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |
| iPhone Safari 26.5 | iOS 26.5 simulator on macOS, native Safari via XCTest | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |

Two limits belong next to those numbers:

- Next.js on desktop Safari with the `browser` engine has a full native pass, but Safari's per-tab memory limit still causes intermittent failures on the tested 16 GiB Mac. No GC mitigation ships.
- The iPhone Safari column ran in the iOS 26.5 simulator on a Mac, which uses the Mac's CPU and memory. The page applies iPhone memory caps there, but the simulator does not reproduce a physical phone's memory pressure, and this run did not include a physical iPhone.

[Run the framework matrix](goals-matrix.md) documents the runner commands. They assume the maintainer's build queue and Mac, so expect to adapt paths.

## Server and tool projects

The app matrix installs each project fresh from an offline copy of the npm registry, then runs its commands on QuickJS and JSC under the native Wasmtime launcher, on the `browser` engine under the headless Node host (`web/scripts/node-host.mjs`), and in headless Chromium for playground stages. A stage passes only when its declared check passes: an exit code and output, an HTTP response body, or rendered DOM text. A passing `bun install` alone does not count as the app working.

Snapshot date: 2026-10-17, checkout `ec213e8ee326336f31feea9ef5763e793b9e2d60`, 180 stage records excluding native Bun controls. Every project gave the same result on all three engines tested. The snapshot recorded 120 passing, 48 failing and 12 blocked stages. This matrix has not been rerun since. Most of its failures were Vite, SvelteKit, Astro and Next.js, which now pass in the 2026-11-23 browser framework matrix above, so read the failures below as historical.

Nine projects passed every stage:

| Project | Version | Stages that pass |
| --- | --- | --- |
| Hono | 4.10.2 | install, start in native and playground hosts |
| Elysia | 1.4.13 | install, start |
| Express | 5.1.0 | install, start |
| Fastify | 5.6.1 | install, start |
| Koa | 3.0.1 | install, start |
| Drizzle ORM | 0.44.6 | install, query in native and playground hosts |
| Prettier | 3.6.2 | install, check in native and playground hosts |
| TypeScript | 5.9.3 | install, check, reject a type error in native and playground hosts |
| ESLint | 9.38.0 | install, lint, reject `debugger` in native and playground hosts |

Eight projects installed or attempted install and failed at least one stage in that 2026-10-17 run:

| Project | Version | Result | First recorded blocker |
| --- | --- | --- | --- |
| Vite for vanilla, React and Vue | 7.1.12 | install passes; `dev` and `build` fail | No diagnostic before exit or deadline |
| SvelteKit | 2.43.1 | install passes; `dev` and `build` fail | No diagnostic before exit or deadline |
| Astro | 5.14.1 | install passes; `build` fails | No diagnostic before exit or deadline |
| Vitest | 3.2.4 | install passes; `test` and `threads` fail | No diagnostic before exit or deadline |
| Next.js | 15.5.6 | install passes; `dev` and `build` fail; `start` blocked by `build` | `LinkError: Unsupported WebAssembly export table` |
| Prisma | 6.17.1 | install fails; three later stages blocked | `memory allocation of 16770432 bytes failed` |

"No diagnostic" means the runner captured no error text before the process exited. Later investigation traced the Vite family exits to a missing `ws` builtin reached via `process.versions.bun` and a stdin EOF that closed Vite's server; see [Framework exits and Vite reloads](app-matrix/exit-provenance.md). The runtime now supplies `ws`; see [The ws builtin](ws-builtin.md). Because this older app matrix has not been rerun, Vitest and Prisma remain unmeasured since 2026-10-17.

Prisma's install hit the 512 MiB guest cap in place on 2026-10-17, so its later stages never ran. On QuickJS and JSC, Next.js stopped at a WebAssembly table export rejected by the runtime's `WebAssembly` adapter at that revision. The [run log](app-matrix/compatibility.md) has per-engine detail.

### Reproduce

Build the guests and the native launcher first; see [Development](development.md). The runner isolates networking with Linux `unshare` and `ip`. The first run caches npm metadata and tarballs; later runs replay offline.

```sh
source env.sh
scripts/app-matrix.sh --record --cache="$HOME/.cache/bun-wasm-app-matrix" \
  --apps=hono,express --engines=quickjs,jsc,browser --hosts=native \
  --output=/tmp/bun-wasm-app-matrix
```

Each project row comes from `results[]` in [`docs/app-matrix/measurements/2026-10-17/after.json`](app-matrix/measurements/2026-10-17/after.json). Drop `--record` to replay offline. [The run log](app-matrix/compatibility.md) has the commands for the full matrix.

## Bun upstream test suite

The suite runner executes every test file under Bun's `test/` directory against each engine with a 15-second file deadline and a 2,000 ms test deadline. A file counts as fully passing when it exits 0, finishes its report, records at least one passing test, and reports no failures or unhandled errors.

Run date: 2026-10-17, runtime commit `6e93c80c6f9bccc879990bedb999c3efdcd3166f`, upstream suite revision `cd95fa7a13b3f13be73e512b38ec111c1c228084`, 2,305 files.

| Engine | Files fully passing | Observed tests passing | File timeouts |
| --- | ---: | ---: | ---: |
| QuickJS | 411 of 2,305, 17.8% | 20,162 of 58,881 | 51 |
| JSC | 411 of 2,305 | 19,290 | 50 |
| `browser` | 418 of 2,305 | 29,457 | 62 |

Observed counts include only tests that registered before a file ended or timed out, not every test in the suite.

QuickJS by directory for the larger groups:

| Directory | Files | Fully passing |
| --- | ---: | ---: |
| `regression` | 430 | 143 |
| `js/bun` | 557 | 82 |
| `js/node` | 340 | 42 |
| `js/third_party` | 120 | 38 |
| `js/web` | 185 | 28 |
| `bundler` | 107 | 18 |
| `cli` | 257 | 5 |
| `js/sql`, `js/valkey`, `napi`, `v8`, `js/workerd` | 150 | 0 |

The suite counts every missing feature as a failure. Native addon bindings are unavailable in the guest, which covers `napi` and `v8`. [`failures.tsv`](bun-test-suite/failures.tsv) records the first blocker for each failing file. The full 2,305-file suite has not been rerun since 2026-10-17.

### Reproduce

```sh
source env.sh
bun install --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
scripts/bun-suite.sh --network loopback --jobs 6 --timeout 15 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /tmp/quickjs.json
```

Pass `--engine jsc` or `--engine browser` for the other engines, or pass a file path after the options to run one file. [The suite results](bun-test-suite/results.md) hold the full commands, per-directory tables for every engine, and failure classifications. `bun scripts/refresh-compatibility-docs.ts --check` checks that the committed tables match the raw JSON.

## Node and Web APIs

Each area below has its own reference page with supported behavior and known gaps:

- [`node:net`, `Bun.connect`, `Bun.listen`, WebSocket](tcp.md)
- [`node:http` and upgrades](http-compatibility.md)
- [`node:worker_threads`](worker-threads.md)
- [Web Crypto and Node key APIs](crypto.md)
- [Data parsers and glob](parsers-glob.md)
- [Bun's generated JavaScript builtins](bun-builtins.md)
- [Installing npm packages](install.md)
