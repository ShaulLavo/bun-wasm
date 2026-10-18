# Bun in WebAssembly

Bun's Rust toolchain and a Bun-compatible runtime run under wasmtime and in the browser on QuickJS, JavaScriptCore or the host JavaScript engine.

```sh
source env.sh
scripts/sync-bun.sh
scripts/build.sh
wasmtime run dist/bun.wasm -e 'console.log("Hello from Bun")'
```

- [Browser package and toolchain guide](docs/package.md)
- [Playground](web/README.md) and [sandbox](sandbox/README.md)
- [Bun suite](docs/bun-test-suite/README.md) and [app compatibility](docs/app-matrix/README.md)
- [JavaScriptCore build](jsc/README.md)
- [Bun and Node builtins](docs/bun-builtins.md)
- [Runtime TypeScript](docs/runtime-typescript.md)
- [Upstream changes](docs/bun-patches.md)
- [Site and guest publishing](site/README.md)
