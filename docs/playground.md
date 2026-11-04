# web: Bun in your browser

A static playground that runs `bun.wasm` (wasm32-wasip1) in the browser: an xterm.js terminal with
a tiny shell, a CodeMirror editor over a shared in-memory filesystem, and a Run button.

## Build

```sh
cd web
bun install
bun run build                       # -> web/dist/ (static files)
BUN_WASM=/path/to/x.wasm bun run build   # use another wasm instead of ../dist/bun.wasm
```

The build gzips each engine's wasm from `../dist` into `dist/<name>.wasm.gz`; the page decompresses
it. If one is missing the build still succeeds and that engine says it is missing. `?wasm=<url>`
loads a different module at runtime; `?trace` logs every WASI call to the worker's console.

## Engines

The header dropdown (`?engine=`) picks what runs the program:

| `?engine=` | wasm | built by | override |
| --- | --- | --- | --- |
| `browser` (default) | `bun-browser.wasm`: transpiler, resolver, `bun build`, sqlite and natives only | `scripts/build-bun-browser.sh` | `BUN_BROWSER_WASM` |
| `quickjs` | `bun.wasm`: QuickJS compiled to wasm | `scripts/build.sh` | `BUN_WASM` |
| `jsc` | `bun-jsc.wasm`: JavaScriptCore compiled to wasm (no JIT) | `scripts/build-jsc.sh`, then `scripts/build-bun-jsc.sh` | `JSC_WASM` |

With `browser`, the wasm's `_start` sets the program up and returns; the worker then hands the
instance to `src/engine-host.js`, which runs the runtime's JS and the user's code on the worker's
own engine (V8 or JavaScriptCore, with JIT). `bun build`, `--version` and `--help` still finish
inside `_start`. Networking is the same as on the wasm engines (below), through the same
`NetHost`. ES modules are served by the service worker's `./__bunwasm/` scope so that imports can
form cycles (`src/sw.ts`; docs/engine-browser.md). (`JSC_WASM` is not `BUN_JSC_WASM` because Bun refuses to start when a
`BUN_JSC_*` variable is not a JSC option.)

## Preview

```sh
bun run preview          # http://127.0.0.1:4173, cross-origin isolated (COOP/COEP headers)
ISOLATE=0 bun run preview   # same, without isolation: exercises the busy-wait sleep fallback
HOST=0.0.0.0 PORT=8080 bun run preview
```

The preview sends each file's `Cache-Control` from `dist/_headers`, as Cloudflare does. Hashed
`chunks/*.js` files are cached as immutable; everything else is revalidated. `LATENCY_MS=70 bun run
preview` delays every response, which shows what network round trips cost a remote user.

`dist/` is plain files; any static host works. Without COOP/COEP headers the page is not
cross-origin isolated, so `poll_oneoff` sleeps spin in the worker instead of using `Atomics.wait`.
To get `Atomics.wait` on a static host, serve with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Browser-engine module loading also creates `blob:` URLs for acyclic modules. If the host sets a
Content-Security-Policy, its `script-src` must allow `blob:` (alongside the policy's existing
Wasm and eval permissions). Import cycles use the service worker's same-origin module URLs.

## Networking

When the page is cross-origin isolated, the program gets the `bun_wasm` host functions
(docs/host-abi.md): `fetch`, `Bun.serve` and `node:http` work, on every engine (the browser engine
calls the same `NetHost` from JS). Without isolation there is no SharedArrayBuffer: on the wasm
engines the slots stay empty and network APIs report "not supported"; the browser engine falls back
to the worker's own `fetch`, with no servers.

- **fetch** runs as the page's own `fetch`, so CORS applies: a cross-origin server must send
  `Access-Control-Allow-Origin`, or the guest gets the browser's `TypeError` ("Failed to fetch" in
  Chromium, "Load failed" in Safari). Custom response headers need `Access-Control-Expose-Headers`.
  `redirect: "manual"` gives the browser's opaque redirect (status 0, no headers).
- **Bun.serve / node:http**: when a guest server listens, the terminal prints a preview link,
  `./__preview/<port>/`. A service worker (scope `./__preview/`, so it never controls the playground
  page) forwards those requests to the page, which hands them to the guest as HTTP/1.1 connections.
  Root-relative URLs inside a preview page (`/app.js`) go to the same server. `http://localhost:<port>`
  printed in the terminal is clickable too. Ctrl-C stops the server.
- A guest fetching its own server (`fetch(server.url)`) or `net.connect`ing to its own listener stays
  inside the worker; other TCP connections are unsupported in the browser.

How it moves: the bun worker is blocked in wasm, so it can't receive messages. It posts requests to
the page (`src/net/host.ts` → `src/net/helper.ts`), and the page writes results (response head, body
chunks, end, errors, new connections) into a per-run SharedArrayBuffer ring (`src/net/ring.ts`). The
guest's `poll` sleeps on the ring with `Atomics.wait`; every other host call drains it without
blocking. Fetch bodies are flow-controlled (at most 512 KiB ahead of what the guest has read).
`src/net/trampoline.ts` installs the JS functions in bun.wasm's function table through a tiny
hand-encoded wasm module (no `WebAssembly.Function`, which Safari lacks).

Tests: `bun test tests/` (unit), `node tests/browser-net.mjs [chromium|webkit]` (after `bun run build`;
Chromium desktop and WebKit iPhone against local servers), `node tests/browser-engine.mjs
[chromium|webkit]` (the `browser` engine: examples, exit codes, Ctrl-C, readline, fetch; `ENGINE=quickjs`
runs it on another engine), or `scripts/test-web.sh` for everything. `node tests/bench-engines.mjs
[chromium|webkit]` prints a table comparing the engines (wasm size, startup, `tests/bench/micro.js`,
which examples pass).

`bash scripts/test-web-host.sh` runs the artifact-free Web host CI gate, including both persistence
backends and the editor startup-steal regressions. CI calls its unit and browser phases around
browser installation. `scripts/test-web.sh` calls the same phases before its WASM integration gates.

Build the playground, copy `web/dist` to a macOS machine, and serve it with COOP/COEP headers.
Run `bun web/tests/browser-startup-safari.ts <playground-url>` on macOS to check fresh startup, three durable reloads, newest-tab ownership, and recovery of the displaced tab.
Set `SAFARI_IOS=1` for the iPhone 17 Pro simulator, `SAFARI_OUTPUT=<path>` for the JSON report, and `SAFARI_SCREENSHOT=<path>` for the error screenshot.
If the simulator is shut down, run `xcrun simctl boot "iPhone 17 Pro"` and `xcrun simctl bootstatus "iPhone 17 Pro" -b` before starting the driver.
Set `SAFARI_SEED_URL=https://bun.sprockt.dev/playground/` to import a workspace created by the live build before testing the candidate.
The test uses its own Safari automation session and driver. It preserves normal browser profiles.

The filesystem lifecycle regression uses the actual page adapter and persistence worker without
guest WASM. `scripts/test-web.sh` runs its Chromium and WebKit cases, plus the storage fencing tests.
For real Safari, build with `bun web/tests/browser-filesystem-lifecycle.ts --build <directory>`
Copy the assets and runner to a macOS machine,
then serve them on an unused localhost port with COOP `same-origin` and COEP `require-corp`.
Run `bun browser-filesystem-lifecycle.ts safari <url>` and repeat with
`SAFARI_IOS=1` for the booted iPhone 17 Pro simulator. `SAFARI_OUTPUT=<file>` records lifecycle
and lock observations. Both Safari platforms cover same-tab reopen, Reload, cached-page
restoration, Reload after Back with no other tab, newest-wins IndexedDB ownership, preserved
visible edits and durable saves. OPFS keeps no-steal ownership and checks refusal and recovery
after the owner closes.

## Without a browser

`bun scripts/run.ts <file.wasm> [args…]` runs a wasm binary under the same WASI shim and seeded
filesystem from the command line (`WASI_TRACE=1` traces syscalls), for comparing with wasmtime.
It provides the same networking slots, with a Bun worker (`scripts/net-helper.ts`) in the page's
role: fetches use Bun's fetch (no CORS) and guest servers also listen on real `127.0.0.1` ports.
`NET=0` turns networking off; `TEST_*` environment variables pass through to the guest.
`bun run check` type-checks.

## How it works

- `waffle/fs/memory`: the in-memory filesystem used by the host adapters; `src/fs.ts` re-exports
  this installed Waffle package entrypoint for standalone consumers.
- `waffle/core/wasi`: the WASI preview1 implementation over the Waffle filesystem service. Any import
  it does not implement gets an ENOSYS stub that prints `[wasi] unimplemented import …` once.
- `src/worker.ts`: the worker entry. Each `bun …` command starts a fresh worker running Waffle's
  process bootstrap with Bun's executor (`src/bun-executor.ts`, `createBunExecutor`, which has no
  import side effects): it instantiates the precompiled module, streams `fd_write` on fds 1/2 back
  as it happens, and uses the live filesystem service.
  Ctrl-C sends SIGINT: an ordinary program stops immediately with 130; a registered handler may
  clean up and retain its own exit code. A second stop request sends SIGKILL. Completed writes remain visible.
- `bash-web/session`: `BrowserSession` connects xterm input, resize, output, and shell state
  to the page-owned runtime. bash-web owns the input queue, output batching, display newline
  conversion, and interactive shell. The playground selects zsh-style editing by default.
  The default prompt is provided by `bash-web/prompt` from the same borrowed filesystem; it reads
  `$HOME/.config/bash-web/prompt.json` when present. Use `?prompt=off` only for transcript or
  measurement controls that require the plain `$ ` fallback.
- `src/runner.ts`: loading an engine's wasm and starting one `bun …` run in a worker with its
  networking; the sandbox (../sandbox/) uses it too. Every run roots a generic Waffle process
  tree, so the root, its children and the shell spawn through the page runtime's one service.
- `src/subprocess-broker.ts`, `src/bun-launcher.ts`: Bun's composition over that service. The
  launchers start one worker per `bun:<engine>` or `preview1` process; the broker adopts a run's
  root and forwards generic requests and signals without rewriting executable names.
- `src/main.ts` renders the page's Remix 3 components from `src/playground/`. `playground.ts` owns
  the page's one runtime, the workspace, bun.wasm and the shell; `editor.ts` owns the CodeMirror
  documents. The `.tsx` files render the header, editor tabs and terminal pane.

The guest gets `/` preopened and `PWD=/home/user`. WASI has no working directory of its own, so
bun.wasm must `chdir($PWD)` at startup for relative paths to resolve from `/home/user`.

## Bun subprocess workers

The Bun guest imports Waffle's `runtime_proc` process ABI directly (`spawn`, `pipe`, `read`, `write`,
`wait`, `wait_job`, `kill`, `kill_job`, `poll`, `signal`, plus WASI `fd_close`); the only host slots
left are the 14 network ones (`src/net/trampoline.ts`). A synchronous wasm call
reserves a pid immediately and the page runtime lazily loads Waffle's `proc/` service to start one
worker per process. The executable registry maps a name to a compiled module and guest
adapter; modules are shared between fresh workers, never retained guest instances. Executable
locations and PATH lookup are documented in [the package guide](browser-package.md#installation-and-ownership).
Preview1 roots keep their explicitly supplied modules and do not register self aliases. A fixture
that spawns itself registers a real file such as `/usr/libexec/test-guest`.
The module service-worker scope is prepared for every parent engine, so Bun light children can
load cyclic modules even when their parent uses QuickJS or JSC. The host never starts a native executable. The headless Node adapter maintains its explicit
canonical executable registry and real filesystem preopens.

Each process has separate argv, environment, cwd and descriptors. Pipes are Waffle's process-owned
rings; closing the last writer sends EOF and `wait` polls the exit status.
SIGINT, SIGTERM and SIGPIPE use per-process, per-signal dispositions. Without a registered
handler, the supervisor immediately records `128 + signal` and revokes before termination.
Ignored signals do nothing; handled signals queue for the guest and preserve its own exit code.
Node/Bun listener registration and removal publish synchronously; removing the final handler
restores default. Ordinary `process.exit(143)` remains an ordinary exit, not a SIGTERM result.
SIGKILL always records 137 and revokes; it cannot be caught or ignored. Cooperative event-loop
turns deliver registered handlers; unhandled default actions do not depend on CPU-bound engine checkpoints. A second Run/Ctrl+C stop request sends SIGKILL; no timer escalates.
Jobs and pids have separate namespaces; foreground job termination leaves other background jobs
alive, and ordinary parent exit does not kill children. The generic service imposes no
four-active-child limit. Each wasm instance retains the module's 512 MiB memory limit, and Node
children have a 128 MiB JS heap limit.

All browser processes connect to one live filesystem worker. Completed writes are immediately
visible to the editor and other processes; there is no copy-at-spawn or merge-at-exit. Each
process has its own revocable identity. Calling `terminate()` is not proof of death. The controller
revokes first, then waits for the filesystem's shared critical-section admission fence before
reaping locks and requesting termination; an ordinary guest exit acknowledgement also proves
quiescence. Killed
process buffers are never reused for another process. Node workers use their real preopens.

Browser children do not share the parent's networking ring. The browser engine
still has direct host `fetch`; QuickJS/JSC children have no networking slots.
The playground's root stdin remains EOF, and children inherit it as EOF. Inherited output goes
to the root's stdout/stderr through its terminal descriptions.

Run `node --no-warnings web/tests/subprocess.mjs` for Node worker checks, or build
web/ and run `bun web/tests/browser-subprocess.ts` for Chromium and WebKit
checks across all three engines. `bun test web/tests/live-filesystem.test.ts` checks live
filesystem visibility between processes. The artifact-free
`bun web/tests/browser-process.ts chromium|firefox|webkit` gate exercises the generic supervisor
and real workers, including cooperative CPU-loop signal handling and background jobs.
Add `--artifact` to use the existing Bun light WASM for orphan-lifetime and capacity checks;
add `--benchmark` to compare cold and shared-module first output between two revisions.
The benchmark checks that both revisions use identical WASM bytes and owns its browser
profiles, servers and scratch cleanup. Network transfer is excluded; no worker pool exists,
so there is no pool timing. Each browser also passes 15 process checks, including eight
orphan-survival cycles that recover all child slots and supervisor records, with zero
active process workers after cleanup.
