# bun-wasm

Bun's Rust toolchain compiled to WebAssembly, with a Bun-compatible runtime for browsers and a native Wasmtime launcher.

## Build and run

```sh
source env.sh && scripts/sync-bun.sh
scripts/build.sh
cargo build -j 4 --release -p bunwasm-host
printf 'console.log("hello from bun-wasm");\n' > index.ts
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$PWD/dist/bun.wasm" \
  --dir "$PWD::/" --env PWD=/ -- run /index.ts
```

Use this launcher, not plain `wasmtime run`: it supplies the `runtime_proc` imports.

## Links

- [Project overview and supported tools](docs/overview.md)
- [Browser package installation, ownership and offline guests](docs/browser-package.md)
- [Playground](docs/web.md) · [React sandbox](docs/sandbox.md)
- [Browser engine](docs/engine-browser.md) · [Host ABI](docs/host-abi.md)
- [Bun builtins](docs/bun-builtins.md) · [Runtime TypeScript](docs/runtime-typescript.md)
- [Bun test-suite compatibility](docs/bun-test-suite/guide.md)
- [Dependency patches and provenance](docs/bun-patches.md)
