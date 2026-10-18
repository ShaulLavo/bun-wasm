# JavaScriptCore for WebAssembly

This builds Bun's JavaScriptCore engine and the `bun-jsc.wasm` guest for `wasm32-wasip1`.

Run from the repository root with the toolchains configured:

```sh
source env.sh
scripts/build-jsc.sh
scripts/build-bun-jsc.sh
scripts/test.sh --engine jsc
```

[Build setup, private target directories, engine details and benchmarks](../docs/jsc.md).
