# bun-wasm

Bun's Rust toolchain and a Bun-compatible runtime compiled to WebAssembly for browsers and wasmtime.

```sh
source env.sh
scripts/sync-bun.sh
scripts/build.sh
wasmtime run --dir .::/ dist/bun.wasm run /index.ts
```

Applications can install this repository as the `bun-wasm` Git dependency and share their existing Waffle runtime.

```ts
import { installBunAdapters } from "bun-wasm";
const installation = await installBunAdapters(runtime, { workerUrl });
installation.dispose();
```

- [Package installation and usage](docs/overview.md)
- [Code quality checks](docs/code-quality.md)
- [Browser playground](web/README.md) and [sandbox](sandbox/README.md)
- [Upstream patches and adapted source](docs/bun-patches.md)
- [Compatibility evidence](docs/bun-test-suite/README.md)
