# Bun in WebAssembly

Bun's toolchain and a Bun-compatible runtime run on QuickJS, JavaScriptCore or the browser's engine in WebAssembly.

From the repository root:

```sh
source env.sh
scripts/sync-bun.sh
scripts/build.sh
wasmtime run dist/bun.wasm -e 'console.log(Bun.version)'
```

[Live demo](https://bun.sprockt.dev/) · [Guide](docs/guides/project.md) · [Compatibility](docs/http-compatibility.md).
