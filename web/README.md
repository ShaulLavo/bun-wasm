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
| `jsc` | `bun-jsc.wasm`: JavaScriptCore compiled to wasm (no JIT) | `scripts/build-bun-jsc.sh` | `JSC_WASM` |

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

`dist/` is plain files; any static host works. Without COOP/COEP headers the page is not
cross-origin isolated, so `poll_oneoff` sleeps spin in the worker instead of using `Atomics.wait`.
To get `Atomics.wait` on a static host, serve with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

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

## Without a browser

`bun scripts/run.ts <file.wasm> [args…]` runs a wasm binary under the same WASI shim and seeded
filesystem from the command line (`WASI_TRACE=1` traces syscalls), for comparing with wasmtime.
It provides the same networking slots, with a Bun worker (`scripts/net-helper.ts`) in the page's
role: fetches use Bun's fetch (no CORS) and guest servers also listen on real `127.0.0.1` ports.
`NET=0` turns networking off; `TEST_*` environment variables pass through to the guest.
`bun run check` type-checks.

## How it works

- `src/fs.ts`: the in-memory filesystem (plain objects, so it can be structured-cloned).
- `src/wasi.ts`: a WASI preview1 implementation over it. Any import it does not implement gets an
  ENOSYS stub that prints `[wasi] unimplemented import …` once.
- `src/worker.ts`: each `bun …` command starts a fresh worker, instantiates the precompiled module,
  streams `fd_write` on fds 1/2 back as it happens, and uses the live filesystem service.
  Ctrl-C requests SIGINT; a second stop request sends SIGKILL. Completed writes remain visible.
- `src/shell.ts`: line editing, history, Tab completion, `;`/`&&`, `>`/`>>`, and the builtins
  `ls cat echo cd pwd mkdir rm mv touch edit clear history help`.
- `src/runner.ts`: loading an engine's wasm and starting one `bun …` run in a worker with its
  networking; the sandbox (../sandbox/) uses it too.
- `src/main.ts`: layout, editor tabs, Run button.

The guest gets `/` preopened and `PWD=/home/user`. WASI has no working directory of its own, so
bun.wasm must `chdir($PWD)` at startup for relative paths to resolve from `/home/user`.

## Bun subprocess workers

When the page is cross-origin isolated, the subprocess ABI reserves a pid immediately and the
page broker lazily loads `runtime/proc` to start one worker per process. A synchronous wasm call
cannot block that startup. The executable registry maps a name to a compiled module and guest
adapter; modules are shared between fresh workers, never retained guest instances. `bun`, `/bun`,
`node`, `/node`, `/usr/local/bin/bun` and `/usr/local/bin/node` select Bun light. `bun-quickjs`, `bun-jsc` and `bun-browser` select
an engine explicitly instead of inheriting the parent's engine. Other registered preview1
programs use the same service; missing programs exit 127 and unrunnable programs exit 126.
The module service-worker scope is prepared for every parent engine, so Bun light children can
load cyclic modules even when their parent uses QuickJS or JSC. The host never starts a native executable. The headless Node adapter maintains its explicit
Bun alias registry and real filesystem preopens.

Each process has separate argv, environment, cwd and stdio. Bun's existing bounded 1 MiB pipe
transport remains until step 4b. Closing stdin sends EOF; `child_wait` polls the exit status.
SIGINT, SIGTERM and SIGPIPE publish a shared interrupt so a guest can handle the signal and
keep its own exit code. An explicit default action reports `128 + signal`; SIGKILL immediately
records 137 and revokes before requesting physical termination. Engine-specific checkpoints
are step 7a. A second Run/Ctrl+C stop request escalates to SIGKILL; the runtime adds no timer.
Jobs and pids have separate namespaces; foreground job termination leaves other background jobs
alive, and ordinary parent exit does not kill children. Bun's adapter retains its four-active-child
budget; the generic service does not impose that limit. Each wasm instance retains the module's
512 MiB memory limit, and Node children have a 128 MiB JS heap limit. Close child handles after
consuming output to release transport buffers.

All browser processes connect to one live filesystem worker. Completed writes are immediately
visible to the editor and other processes; there is no copy-at-spawn or merge-at-exit. Each
process has its own revocable identity. Calling `terminate()` is not proof of death. The controller
revokes first, then waits for the filesystem's shared critical-section admission fence before
reaping locks and requesting termination; an ordinary guest exit acknowledgement also proves
quiescence. Killed
process buffers are never reused for another process. Node workers use their real preopens.

Browser children do not share the parent's networking ring. The browser engine
still has direct host `fetch`; QuickJS/JSC children have no networking slots.
Browser subprocess `stdin: "inherit"` shares the parent's stdin pipe when the
parent has one; the playground's root stdin remains EOF. Inherited output goes
to the parent's stdout/stderr, and ignored output is drained and discarded.

Run `node --no-warnings web/tests/subprocess.mjs` for Node worker checks, or build
web/ and run `bun web/tests/browser-subprocess.ts` for Chromium and WebKit
checks across all three engines. `bun test web/tests/subprocess.test.ts` checks
pipe wrapping, live filesystem visibility, and the Node worker checks. The artifact-free
`bun web/tests/browser-process.ts chromium|firefox|webkit` gate exercises the generic supervisor
and real workers, including cooperative CPU-loop signal handling and background jobs.
