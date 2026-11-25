# Compatibility

What runs, what fails, and how each number was measured. Every number here comes from a recorded run, and each section gives its date and revision.

Three yardsticks measure compatibility:

- The framework matrix runs 13 framework starters in four browsers on four engines, from `bun install` to a production build. Last run: 2026-11-23, all 208 combinations pass. iPhone Safari runs in the iOS simulator.
- The app matrix runs 17 server, database and tool projects under the native launcher. Last run: 2026-10-17. The records are in [`docs/app-matrix/`](app-matrix/README.md).
- Bun's own test suite runs upstream test files against each engine. Last full run: 2026-10-17. The records are in [`docs/bun-test-suite/`](bun-test-suite/README.md).

## Bun commands

`crates/bunwasm-cli/src/main.rs` dispatches these commands.

| Command | Status |
| --- | --- |
| `bun run <file>`, `bun <file>`, `bun run <script>` | Supported. TypeScript, TSX, JSX and TOML load through Bun's transpiler. |
| `bun -e <code>`, `bun -p <code>` | Supported. |
| `bun test` | Supported. See the [suite results](#bun-upstream-test-suite). |
| `bun build`, `Bun.build` | Supported, through Bun's bundler. |
| `bun install`, `bun i`, `bun ci`, `bun add`, `bun remove`, `bun update`, `bun x`, `bun pm` | Supported. Needs a network host. See [Installing npm packages](install.md). |
| `bun lint`, `bun fmt` | Run in a separate guest, `bun-tools.wasm`. Without that file the playground build warns that lint and fmt are unavailable. |
| `bun exec <script>`, `Bun.$` | Supported. They run in the page's system shell, `/bin/sh` or `/bin/bash`, which bash-web's `installShellCommands` provides. |
| `bun init` | Supported for the blank and minimal templates. There is no template picker, so it always takes Blank; `--react` is not supported. |
| `bun create <template>` | Supported for npm `create-<template>` packages, for example `bun create vite`. GitHub and local templates are not. |
| `bun repl` | Supported. Typed input from bash-web's terminal does not reach Bun yet, so today it reads piped input only. |
| `bun upgrade`, `link`, `unlink`, `outdated`, `publish`, `patch`, `patch-commit`, `info`, `why`, `audit`, `completions`, `dedupe`, `prune`, `check`, `deploy`, `cloud`, `config`, `use`, `auth`, `login`, `logout` | Not supported. They print `error: bun <command> is not supported in bun-wasm` and exit 1. |

## Engines

One runtime runs on four JavaScript engines behind the `Engine` trait. Each engine has its own guest build. QuickJS, JavaScriptCore and SpiderMonkey ship as a Bun core module plus an engine module that links into the core's memory at load time. Sizes are uncompressed, as the playground reported them in Chrome on 2026-11-23.

| Engine | JS runs on | Modules | Size |
| --- | --- | --- | ---: |
| `browser` (default in the browser) | The host's own engine with JIT: V8 in Chrome, SpiderMonkey in Firefox, JavaScriptCore in Safari | `bun-browser.wasm` | 15.5 MiB |
| `quickjs` | QuickJS-ng compiled into the wasm | `bun.wasm`, `quickjs.wasm` | 18.1 MiB |
| `jsc` | JavaScriptCore compiled into the wasm, interpreter only | `bun-jsc.wasm`, `jsc-engine.wasm` | 49.1 MiB |
| `spidermonkey` (experimental, opt-in) | SpiderMonkey compiled into the wasm, interpreter | `bun-spidermonkey.wasm`, `spidermonkey-engine.wasm` | 27.0 MiB |

The native launcher runs the engines inside the wasm. The `browser` engine needs a host with a JavaScript engine of its own. The package registers SpiderMonkey only when you ask for it ([SpiderMonkey host integration](spidermonkey-host-plumbing.md)).

The `browser` engine differs from the others in these ways, because it runs on a standard JS engine without engine hooks ([The browser engine](engine-browser.md#what-is-inherently-different)):

| Behavior | `browser` engine |
| --- | --- |
| Promise state | Known only for promises settled where the host sees it. Others print as `<pending>`, and `Bun.peek` returns them unchanged. |
| `AsyncLocalStorage` across `await` | Carried by transpiler hooks. Code that skips the transpiler (`eval`, `new Function`) is not covered. |
| `require()` of an ES module | Runs a converted CommonJS copy, separate from the ES module instance when the file is also imported. |
| Import cycles | Work with or without a service worker, with live bindings and hoisted functions. |
| `Function.prototype.toString` of module code | Keeps names and structure. Formatting, comments and literal spelling may differ from the file. |
| `process.memoryUsage()` | Reads `performance.memory` where available (Chromium), else zeros. |
| Raw `err.stack` strings | Follow the host engine's format. Printed errors (uncaught errors, `console.log(err)`, `bun test`) match the other engines. |

Hermes remains withdrawn from normal publication. In the retained Hermes revision `c36356f416ee19bb0d54c2e7ecb3c5fb0538a065`, `Object.isSealed` and `Object.isFrozen` return false for sealed or frozen objects wrapped in an empty-handler Proxy. This known engine limitation has no workaround; it does not affect the supported Browser engines. See [Dormant Hermes source](hermes-engine.md#known-engine-limitation).

## Frameworks in the browser

The framework matrix opens the sandbox in a real browser, picks a starter and an engine, and drives it the way a person would. A combination passes only when all nine phases pass:

1. Startup: the guest loads and reports the selected engine.
2. Install: `bun install` exits 0.
3. Dev: the framework's dev server starts and gives a preview URL.
4. Render: the preview shows the starter's text.
5. Click: a trusted click changes the counter from 0 to 1.
6. Hot reload: an edited source file shows up in the same document, with the counter state kept and no navigation.
7. Build: the production build exits 0.
8. Preview: the built app serves, renders, and its counter responds to a click.
9. Cleanup: the dev process and the preview stop and the browser closes.

Run: 2026-11-23, all 208 combinations re-run that day, 208 pass. 146 ran on main `587c2c69c`, 54 on main `3b84f36a3`, and 8 iPhone combinations on `587c2c69c` with PRs 1052 and 1056, which raise the iPhone memory caps and have since merged. The guests were Bun v1.4.4. Each phase has a 300-second hang cap, install and build have 600 seconds. The caps catch hangs and say nothing about speed.

| Framework | Template |
| --- | --- |
| Next.js 15 | `template-next` |
| Nuxt | `template-nuxt` |
| SvelteKit | `template-sveltekit` |
| Astro | `template-astro` |
| React Router | `template-react-router` |
| SolidStart | `template-solidstart` |
| TanStack Start | `template-tanstack-start` |
| Angular | `template-angular` |
| Qwik | `template-qwik` |
| Vite with React | `template` |
| Vite with Vue | `template-vite-vue` |
| Vite with Svelte | `template-vite-svelte` |
| Hono server | `template-hono` |

Templates are under `sandbox/`. Each framework passes on every cell of this grid:

| Browser | Where it ran | `browser` | `quickjs` | `jsc` | `spidermonkey` |
| --- | --- | --- | --- | --- | --- |
| Chrome 157 | Linux PC, headless | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |
| Firefox 157 | Linux PC, Playwright Firefox | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |
| Safari 26.4 | Mac, native Safari through safaridriver | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |
| iPhone Safari 26.5 | iOS 18.7 simulator on the Mac, native Safari driven through XCTest | 13 of 13 | 13 of 13 | 13 of 13 | 13 of 13 |

One caveat: Next.js on desktop Safari with the `browser` engine passed, but Safari's per-tab memory limit still kills that combination intermittently on the 16 GiB Mac we test on. No workaround ships.

The iPhone column runs in the simulator, which uses the Mac's CPU and memory. The page applies the iPhone memory caps there, but the simulator does not reproduce a real phone's memory pressure, and this run did not include a physical iPhone.

[Run the framework matrix](goals-matrix.md) has the commands. They assume the maintainer's build queue and Mac, so expect to adapt paths.

## Server and tool projects

The app matrix installs each project fresh from an offline copy of the npm registry, then runs its commands on QuickJS, JSC and the `browser` engine under the native launcher and in headless Chromium. A stage passes only on its declared assertion: an exit code and output, an HTTP response with the expected body, or rendered DOM text. An install that succeeds does not count as the app working.

Snapshot: 2026-10-17, checkout `ec213e8ee326336f31feea9ef5763e793b9e2d60`, 180 stage records excluding the native Bun controls. Every project gave the same result on all three engines it ran on. Overall the snapshot has 120 passing, 48 failing and 12 blocked stages. This matrix has not been rerun since. Most of its failures were Vite, SvelteKit, Astro and Next.js, which now pass in the framework matrix above, so read the failures below as history.

Nine projects pass every stage:

| Project | Version | Stages that pass |
| --- | --- | --- |
| Hono | 4.10.2 | install, start (native launcher and playground) |
| Elysia | 1.4.13 | install, start |
| Express | 5.1.0 | install, start |
| Fastify | 5.6.1 | install, start |
| Koa | 3.0.1 | install, start |
| Drizzle ORM | 0.44.6 | install, query (native launcher and playground) |
| Prettier | 3.6.2 | install, check (native launcher and playground) |
| TypeScript | 5.9.3 | install, check, reject a type error (native launcher and playground) |
| ESLint | 9.38.0 | install, lint, reject `debugger` (native launcher and playground) |

Eight projects install but fail at least one later stage:

| Project | Version | Result | First recorded blocker |
| --- | --- | --- | --- |
| Vite (vanilla, React, Vue) | 7.1.12 | install passes. `dev` and `build` fail. | No diagnostic before exit or deadline |
| SvelteKit | 2.43.1 | install passes. `dev` and `build` fail. | No diagnostic before exit or deadline |
| Astro | 5.14.1 | install passes. `build` fails. | No diagnostic before exit or deadline |
| Vitest | 3.2.4 | install passes. `test` and `threads` fail. | No diagnostic before exit or deadline |
| Next.js | 15.5.6 | install passes. `dev` and `build` fail. `start` is blocked by `build`. | `LinkError: Unsupported WebAssembly export table` |
| Prisma | 6.17.1 | install fails. The three later stages are blocked. | `memory allocation of 16770432 bytes failed` |

"No diagnostic" means the harness saw no error text before the process exited. After this snapshot the cause was traced to a missing `ws` builtin that Vite reaches through `process.versions.bun`, plus a stdin end-of-file that closed Vite's server ([Framework exits and Vite reloads](app-matrix/exit-provenance.md)). The runtime now supplies `ws` ([The ws builtin](ws-builtin.md)). The last measurement is the 2026-10-17 snapshot, where the Vite family fails as the table shows. A rerun after those fixes is pending, so whether they changed the result is not yet known.

Prisma's install ran out of memory in the snapshot's 512 MiB guest, so its later stages never run. On QuickJS and JSC, Next.js stops at a WebAssembly table export that the runtime's `WebAssembly` adapter rejects. The browser engine fails at a different point. The [run log](app-matrix/compatibility.md) has per-engine detail.

### Reproduce

Build the guests and the native launcher first ([Development](development.md)). The runner isolates the network with Linux `unshare` and `ip`. The first run downloads npm metadata and tarballs into the cache. Later runs replay the cache offline.

```sh
source env.sh
scripts/app-matrix.sh --record --cache="$HOME/.cache/bun-wasm-app-matrix" \
  --apps=hono,express --engines=quickjs,jsc,browser --hosts=native \
  --output=/tmp/bun-wasm-app-matrix
```

Each project row comes from `results[]` in [`docs/app-matrix/measurements/2026-10-17/after.json`](app-matrix/measurements/2026-10-17/after.json). Drop `--record` to replay offline. [The run log](app-matrix/compatibility.md) has the commands for the full matrix.

## Bun upstream test suite

The runner executes every test file under Bun's `test/` directory against each engine with a 15-second file deadline and a 2,000 ms test deadline. A file fully passes when it exits zero, finishes a report, has at least one pass, and reports no failures or unhandled errors.

Run: 2026-10-17, runtime commit `6e93c80c6f9bccc879990bedb999c3efdcd3166f`, suite revision `cd95fa7a13b3f13be73e512b38ec111c1c228084`, 2,305 files.

| Engine | Files fully passing | Observed tests passing | File timeouts |
| --- | ---: | ---: | ---: |
| QuickJS | 411 of 2,305 (17.8%) | 20,162 of 58,881 | 51 |
| JSC | 411 of 2,305 | 19,290 | 50 |
| `browser` | 418 of 2,305 | 29,457 | 62 |

Observed counts include only tests that registered before the file ended or timed out. They are not a count of every test in the suite.

QuickJS by directory, for the larger groups:

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

The suite counts every missing feature as a failure. Native addon bindings are unavailable in the guest, which covers `napi` and `v8`. The suite page classifies the first blocker of each failing file in [`failures.tsv`](bun-test-suite/failures.tsv).

The whole suite has not been rerun since 2026-10-17. Runtime work since then has tracked a fixed set of 87 upstream files: 25 under `js/bun`, 42 under `js/node`, 18 under `js/web` and 2 under `js/third_party`. The set covers `bun:test` itself, fs, path, Buffer, streams, crypto, fetch and body, timers, process, URL, encoding and inspection. It is not a random sample, so it says more about those APIs than about the suite as a whole. Its last count, on 2026-11-23 at main `3e121e6dc` against upstream suite revision `9510e7415`, with a 600-second file watchdog and 10-second test limit:

| Engine | Files fully passing | Tests passing | Tests failing |
| --- | ---: | ---: | ---: |
| QuickJS | 67 of 87 | 5,679 | 109 |
| JSC | 67 of 87 | 5,677 | 111 |
| `browser` | 67 of 87 | 5,158 | 124 |

On 2026-11-18 the same set had 40 fully passing files on each engine and 1,206 failing tests on QuickJS.

### Reproduce

```sh
source env.sh
bun install --cwd docs/bun-test-suite/dependencies --ignore-scripts --linker hoisted --frozen-lockfile
scripts/bun-suite.sh --network loopback --jobs 6 --timeout 15 \
  --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" \
  --output /tmp/quickjs.json
```

Add `--engine jsc` or `--engine browser` for the other engines. A single file runs by passing its path after the options. [The suite results](bun-test-suite/results.md) hold the full commands, the per-directory tables for every engine, and the failure classification. `bun scripts/refresh-compatibility-docs.ts --check` verifies that the committed tables match the raw JSON.

## Node and Web APIs

Each of these has its own page with the supported surface and the known gaps:

- [`node:net`, `Bun.connect`, `Bun.listen`, WebSocket](tcp.md)
- [`node:http` and upgrades](http-compatibility.md)
- [`node:worker_threads`](worker-threads.md)
- [Web Crypto and Node key APIs](crypto.md)
- [Data parsers and glob](parsers-glob.md)
- [Bun's generated JavaScript builtins](bun-builtins.md)
- [Installing npm packages](install.md)
