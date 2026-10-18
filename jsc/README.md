# JavaScriptCore in WebAssembly

This port builds Bun's pinned JavaScriptCore for wasm32-wasip1 and uses it as a Bun guest engine.

From the repository root:

```sh
source env.sh
scripts/build-jsc.sh
scripts/build-bun-jsc.sh
scripts/test.sh --engine jsc
```

[Guide and reference](../docs/guides/javascriptcore.md).
