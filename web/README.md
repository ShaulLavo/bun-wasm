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

## Without a browser

`bun scripts/run.ts <file.wasm> [args…]` runs a wasm binary under the same WASI shim and seeded
filesystem from the command line (`WASI_TRACE=1` traces syscalls), for comparing with wasmtime.
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
