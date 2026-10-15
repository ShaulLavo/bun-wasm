# Bun's toolchain in WebAssembly, with a Bun-compatible runtime

Bun's own Rust toolchain (transpiler, bundler, dev server graph, parsers, semver, glob), built for
`wasm32-wasip1`, plus a runtime of our own that implements Bun's and Node's APIs on top of it. It
runs in the browser and under wasmtime. The runtime layer is not Bun's code: Bun's real runtime is
tied to JavaScriptCore internals, so we reimplement it and measure it against Bun's own test suite
([docs/bun-test-suite/](docs/bun-test-suite/README.md)).

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
