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

The build copies `../dist/bun.wasm` (made by `scripts/build.sh`) into `dist/bun.wasm`. If it is
missing the build still succeeds and the page says bun.wasm is missing. `?wasm=<url>` loads a
different module at runtime; `?trace` logs every WASI call to the worker's console.

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

When the page is cross-origin isolated, bun.wasm gets the `bun_wasm` host functions
(docs/host-abi.md): `fetch`, `Bun.serve` and `node:http` work. Without isolation there is no
SharedArrayBuffer, the slots stay empty and network APIs report "not supported".

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
Chromium desktop and WebKit iPhone against local servers), or `scripts/test-web.sh` for everything.

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
  streams `fd_write` on fds 1/2 back as it happens, and returns the filesystem when the program
  exits. Ctrl-C terminates the worker (exit 130, filesystem changes from that run are dropped).
- `src/shell.ts`: line editing, history, Tab completion, `;`/`&&`, `>`/`>>`, and the builtins
  `ls cat echo cd pwd mkdir rm mv touch edit clear history help`.
- `src/main.ts`: layout, editor tabs, Run button, loading bun.wasm.

The guest gets `/` preopened and `PWD=/home/user`. WASI has no working directory of its own, so
bun.wasm must `chdir($PWD)` at startup for relative paths to resolve from `/home/user`.
