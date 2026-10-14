# bun-wasm

Bun, compiled to WebAssembly. Bun's own Rust source (oven-sh/bun, pinned in
`scripts/sync-bun.sh`), built for `wasm32-wasip1`, so it runs under wasmtime and in a
browser.

## What's real Bun and what's glue

| Layer | Source |
| --- | --- |
| Parser, printer, transpiler, bundler, resolver, CSS | **Bun's Rust crates, unmodified in shape** (`vendor/bun`, plus a small `cfg` patch series in `patches/bun`) |
| POSIX surface WASI lacks (signals, processes, mmap, termios, ...) | `third_party/libc` (libc crate fork: declarations) + `crates/bunwasm-posix` (Rust implementations) |
| Bun's C/C++ helpers (simdutf, highway, mimalloc, WTF dtoa/parseDouble, zlib) | `crates/bunwasm-glue`, starting from Bun's own pure-Rust stand-ins (`src/sema/standalone/native.rs`) |
| JS engine | QuickJS-ng via rquickjs, compiled to wasm (`crates/bunwasm-runtime`) |
| `Bun.*`, `process`, `node:*` APIs | Rust glue over the engine (`crates/bunwasm-runtime`) |
| Browser host | `web/`: WASI shim, in-memory FS, xterm terminal, editor |

JavaScriptCore is the one piece of Bun not compiled here: it can't JIT inside wasm, and
Bun's 12 MB of C++ bindings are tied to it, so the engine is swappable instead.

## Building

```sh
source env.sh            # toolchains on /work/cache (rustup, wasi-sdk, wasmtime, binaryen)
scripts/sync-bun.sh      # clone Bun at the pinned commit, apply patches, fetch vendored crates

# Bun's transpiler alone:
cargo build -p bunwasm-transpiler --example transpile --target wasm32-wasip1 --release
wasmtime run --dir .::/ $CARGO_TARGET_DIR/wasm32-wasip1/release/examples/transpile.wasm /app.tsx
```

## Porting Bun crates

`scripts/port-check.sh <crate>` type-checks a crate for wasm32-wasip1 and lists the
errors. `scripts/wasify.py` has the helpers the patch series was written with. The rules
the patches follow:

- WASI is treated as POSIX: `cfg(unix)` became `cfg(any(unix, target_os = "wasi"))`
  across the toolchain crates, and the libc fork supplies what wasi-libc doesn't.
- 64-bit layout asserts are gated to 64-bit targets.
- Pointer-tagged strings use the top three bits of a 32-bit address, so the binary
  links with `--max-memory=536870912` (512 MiB).
- Things a sandbox can't do (signals, exec, file watching, dlopen) get a `target_os =
  "wasi"` arm that fails the way a restricted POSIX system would.
