# Bun compiled to WASM

Bun's own Rust source, built for `wasm32-wasip1`. It runs in the browser and under wasmtime.

- `bun run`, `bun test`, `bun build`, `bun:sqlite`, `fetch`, `Bun.serve`
- Bun's real transpiler and bundler
- JS engine: QuickJS or Bun's JavaScriptCore compiled to wasm, or the browser's own engine ([docs/engine-browser.md](docs/engine-browser.md))

```sh
source env.sh && scripts/sync-bun.sh
scripts/build.sh                      # dist/bun.wasm
wasmtime run --dir .::/ dist/bun.wasm run /index.ts
```
