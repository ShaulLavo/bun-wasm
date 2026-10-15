# bun-wasm

Bun, compiled to WebAssembly. Bun's own Rust source (oven-sh/bun, pinned in
`scripts/sync-bun.sh`) built for `wasm32-wasip1`: one `bun.wasm` that runs under wasmtime,
under a small native launcher with networking, and in a browser.

```sh
wasmtime run --dir app::/ --env PWD=/ dist/bun.wasm run /index.ts
bun-wasm run server.ts          # crates/bunwasm-host: same binary plus fetch and sockets
```

## What works

| Command / API | Status |
| --- | --- |
| `bun run`, `bun <file>`, `bun -e` | TS/TSX/JSX via Bun's real transpiler, ESM + CJS, node_modules, top-level await, source-mapped stack traces |
| `bun build` | Bun's real bundler (BundleV2); byte-identical to native on the fixtures |
| `bun test` | `bun:test` runner: describe/test/each/only/skip, matchers, mocks, hooks, Bun's report format |
| `bun:sqlite` | real SQLite 3.53 compiled to wasm |
| `Bun.*` | file/write, sleep, hash (real wyhash), inspect, deepEquals, serve, gzip, CryptoHasher, ... |
| `node:*` | fs, path, os, util, events, buffer, assert, url, crypto, zlib, readline, stream (subset), http, net, ... |
| `fetch`, `Bun.serve`, `node:http`, `node:net` | through host functions (`docs/host-abi.md`): the native launcher or the browser page; plain wasmtime reports "not supported" |
| Not available | `spawn`/`child_process` (no processes in WASI), `bun install`, WebSockets, snapshots in `bun test` |

`scripts/test.sh` runs 49 end-to-end fixtures against native Bun's output.
`scripts/test-build.sh`, `scripts/test-web.sh`, `scripts/test-jsc.sh` cover the bundler,
the browser host and the JavaScriptCore build.

## What's real Bun and what's glue

| Layer | Source |
| --- | --- |
| Parser, printer, transpiler, bundler, resolver, CSS | **Bun's Rust crates** (`vendor/bun`), plus a `cfg` patch series (`patches/bun`) |
| POSIX surface WASI lacks (signals, processes, mmap, termios, ...) | `third_party/libc` (libc crate fork: declarations) + `crates/bunwasm-posix` (Rust implementations) |
| Bun's C/C++ helpers (simdutf, highway, mimalloc, WTF dtoa/parseDouble, zlib) | `crates/bunwasm-glue`, starting from Bun's own pure-Rust stand-ins (`src/sema/standalone/native.rs`) |
| JS engine | QuickJS-ng (`third_party/rquickjs-sys`, patched for JSC-like stack positions and async context) |
| Experimental engine | **Bun's JavaScriptCore**, compiled to wasm (`jsc/`, `crates/bunwasm-jsc`, `dist/bun-jsc.wasm`) |
| `Bun.*`, `process`, `node:*`, `bun:test`, `bun:sqlite` | `crates/bunwasm-runtime`: Rust natives + JS polyfills |
| Networking host | `crates/bunwasm-host` (`bun-wasm` launcher on wasmtime) and `web/` |
| Browser host | `web/`: WASI shim, in-memory FS, xterm terminal, editor, service-worker previews for `Bun.serve` |

## Building

```sh
source env.sh            # toolchains on /work/cache (rustup, wasi-sdk, wasmtime, binaryen, cmake)
scripts/sync-bun.sh      # clone Bun at the pinned commit, apply patches, fetch vendored crates
scripts/build.sh         # dist/bun.wasm
scripts/test.sh          # build + fixtures
cargo build --release -p bunwasm-host          # the networking launcher
scripts/build-jsc.sh && scripts/build-bun-jsc.sh   # JavaScriptCore (≈10 min), dist/bun-jsc.wasm
scripts/publish-web.sh [app-id]                # playground as a private Mesh app
```

## Porting notes

`scripts/port-check.sh <crate>` type-checks a vendored crate for wasm32-wasip1 and lists the
errors; `scripts/wasify.py` has the helpers the patch series was written with. The rules:

- WASI is treated as POSIX: `cfg(unix)` became `cfg(any(unix, target_os = "wasi"))` across the
  toolchain crates, and the libc fork supplies what wasi-libc doesn't.
- 64-bit layout asserts are gated to 64-bit targets. Two real 32-bit bugs turned up and are
  fixed in the patches: Bun's `strings::eql` (patch 0007) and module import slots in Bun's
  WebKit fork (`jsc/webkit-wasi.patch`).
- Pointer-tagged strings use the top three bits of a 32-bit address, so binaries link with
  `--max-memory=536870912` (512 MiB).
- wasip1 has one thread: Bun's thread pool runs scheduled tasks inline (patch 0004).
- Things a sandbox can't do (signals, exec, file watching, dlopen) get a `target_os = "wasi"`
  arm that fails the way a restricted POSIX system would.
