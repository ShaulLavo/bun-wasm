# Bun compiled to WASM

Bun's own Rust source, built for `wasm32-wasip1`. It runs in the browser and under wasmtime.

- `bun run`, `bun test`, `bun build`, `Bun.build`, `bun:sqlite`, `fetch`, `Bun.serve`
- Bun's real transpiler and bundler
- npm installs in every engine: `bun install`, `bun add`, `bun remove`, and `bun pm ls` ([details](docs/install.md))
- In the browser: a playground ([web/](web/README.md)) and a React sandbox with hot reload ([sandbox/](sandbox/README.md))
- JS engine: QuickJS or Bun's JavaScriptCore compiled to wasm, or the browser's own engine ([docs/engine-browser.md](docs/engine-browser.md))

```sh
source env.sh && scripts/sync-bun.sh
scripts/build.sh                      # dist/bun.wasm
wasmtime run --dir .::/ dist/bun.wasm run /index.ts
```

[Changes to Bun and vendored dependencies](docs/bun-patches.md) lists each patch and distinguishes port work, host features, and upstream bugs.
