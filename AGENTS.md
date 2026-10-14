# bun-wasm

Goal: Bun compiled to WebAssembly. One `bun.wasm` (target `wasm32-wasip1`) that runs
`bun run app.ts`, `bun -e`, `bun build`, etc. under wasmtime and in a browser (WASI shim).
Rust first: glue and polyfills are written in Rust; JS polyfills are fine where Rust is silly.

## Architecture

```
vendor/bun/            oven-sh/bun pinned clone (gitignored), branch `wasm` = our patches
patches/bun/*.patch    the same patches, exported (scripts/sync-bun.sh re-creates vendor/bun)
crates/bunwasm-transpiler   Bun's real Rust parser/printer/transpiler (vendor/bun crates) behind
                            `transpile(source, path, loader) -> js`
crates/bunwasm-runtime      JS engine (QuickJS via rquickjs, compiled to wasm) + Bun/Node API glue
                            in Rust: module loader, Bun.*, process, node:* modules
crates/bunwasm-cli          the `bun` binary: CLI parsing, wires transpiler into runtime
web/                        browser host: WASI shim + in-memory FS + xterm terminal
tests/                      end-to-end fixtures run under wasmtime
```

Why not JavaScriptCore: it can't JIT inside wasm and Bun's 12 MB of C++ bindings are tied to
JSC internals. The engine sits behind the runtime crate so it can be swapped later.

## Environment

`source env.sh` before anything. Toolchains live on /work:
rustup/cargo in /work/cache/{rustup,cargo}; wasi-sdk, wasmtime, binaryen, wasm-tools, cmake,
ninja in /work/cache/wasm-tools. Cargo target dir: /work/tmp/bun-wasm-target.
The machine has ~9 GB free RAM: use `cargo build -j 12` or less for big builds.

## Rules

- Patches to Bun go in vendor/bun on branch `wasm` as commits, then export:
  `scripts/export-patches.sh`. Keep them minimal: add `target_os = "wasi"` arms, don't rewrite.
- No GitHub issues; this repo is local until the owner says otherwise.
- Scratch in /work/tmp/bun-wasm-*; clean it up.
