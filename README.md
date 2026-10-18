# bun-wasm

Bun's Rust toolchain and a Bun-compatible runtime compiled to WebAssembly, running in browsers and under wasmtime.

```sh
source env.sh
scripts/sync-bun.sh
scripts/build.sh
wasmtime run dist/bun.wasm -e 'console.log("hello")'
```

- [Setup and package API](docs/overview.md)
- [Browser playground](docs/web.md) and [React sandbox](docs/sandbox.md)
- [Bun compatibility results](docs/bun-test-suite/guide.md)
- [App compatibility results](docs/app-matrix/guide.md)
- [Upstream changes](docs/bun-patches.md)
