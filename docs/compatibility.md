# Compatibility

What runs, what fails, and how each number was measured. Everything here is a recorded measurement of a specific revision. Where a later commit may have changed a result, the page says so.

Two yardsticks measure compatibility:

- The app matrix runs 17 real projects (install, then start, build, test or lint). The records are in [`docs/app-matrix/`](app-matrix/README.md).
- Bun's own test suite runs 2,305 upstream test files. The records are in [`docs/bun-test-suite/`](bun-test-suite/README.md).

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
| `bun create`, `init`, `upgrade`, `link`, `unlink`, `outdated`, `publish`, `patch`, `patch-commit`, `repl`, `info`, `why`, `audit`, `completions`, `exec`, `dedupe`, `prune`, `check`, `deploy`, `cloud`, `config`, `use`, `auth`, `login`, `logout` | Not supported. They print `error: bun <command> is not supported in bun-wasm` and exit 1. |

## Engines

One runtime runs on three JavaScript engines. The three are built into separate guests. The sizes below are the playground's engine picker and the published browser guest.

| Engine | JS runs on | Guest | Size |
| --- | --- | --- | --- |
| `browser` (default in the browser) | The host's own engine: V8 in Chromium and Node, JavaScriptCore with JIT in Safari | `bun-browser.wasm` | 14.5 MB |
| `quickjs` | QuickJS-ng compiled into the wasm | `bun.wasm` | 9 MB |
| `jsc` | JavaScriptCore without JIT, compiled into the wasm | `bun-jsc.wasm` | 43 MB |

The native launcher runs `quickjs` and `jsc`. The `browser` engine needs a host with a JavaScript engine of its own.

The three engines differ in these ways, which follow from the `browser` engine running on a standard JS engine without engine hooks ([The browser engine](engine-browser.md#what-is-inherently-different)):

| Behavior | `browser` engine |
| --- | --- |
| Promise state | Known only for promises settled where the host sees it. Others print as `<pending>`, and `Bun.peek` returns them unchanged. |
| `AsyncLocalStorage` across `await` | Carried by transpiler hooks. Code that skips the transpiler (`eval`, `new Function`) is not covered. |
| `require()` of an ES module | Runs a converted CommonJS copy, separate from the ES module instance when the file is also imported. |
| Import cycles | Need a module store (a service worker in the browser). Without it a cycle throws `ERR_CIRCULAR_IMPORT`. |
| `process.memoryUsage()` | Reads `performance.memory` where available (Chromium), else zeros. |
| Raw `err.stack` strings | Follow the host engine's format. Printed errors (uncaught errors, `console.log(err)`, `bun test`) match the other engines. |

## Real apps

The matrix installs each project fresh from an offline copy of the npm registry, then runs its commands on QuickJS, JSC and the `browser` engine. A stage passes only on its declared assertion: an exit code and output, an HTTP response with the expected body, or rendered DOM text in headless Chromium. An install that succeeds does not count as the app working.

Snapshot: 2026-10-17, checkout `ec213e8ee326336f31feea9ef5763e793b9e2d60`, 180 stage records excluding the native Bun controls. Every project gave the same result on all three engines. Overall the snapshot has 120 passing, 48 failing and 12 blocked stages.

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

Prisma's install runs out of memory in the 512 MiB guest, so its later stages never run. On QuickJS and JSC, Next.js stops at a WebAssembly table export that the runtime's `WebAssembly` adapter rejects. The browser engine fails at a different point. The [run log](app-matrix/compatibility.md) has per-engine detail.

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
