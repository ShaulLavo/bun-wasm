# Vite 8 official Wasm packages

Classification: original installer adapter. No compiler or loader implementation is copied.

The installer resolves `lightningcss` to official `lightningcss-wasm` at the exact selected version. Its Node export condition selects `wasm-node.mjs` or `wasm-node.cjs`. Both initialize synchronously and preserve `transform`, `transformStyleAttribute`, `bundle`, `bundleAsync`, visitors and thrown compiler errors.

For `rolldown`, `oxc-parser` and `oxc-transform`, the adapter keeps the original package and entrypoints. Matching native binding metadata adds a required exact-version `@<name>/binding-wasm32-wasi` dependency. Existing optional Wasm binding metadata becomes required. The unchanged upstream loader discovers this package after Linux/wasm32 has no native binding. Package archive integrity and resolution errors follow the ordinary installer path. An unavailable same-version release fails instead of selecting a different compiler version.

Metadata adaptation runs for registry resolution and lock replay. Native desktop archives stay in lock metadata but the existing linux/wasm32 platform filter skips extraction. A new lock records the selected official distribution's archive and integrity. A native Lightning CSS lock row is not mistaken for a Wasm archive.

## Upstream sources inspected

- [Lightning CSS docs](https://lightningcss.dev/docs.html), npm `lightningcss-wasm@1.33.0`, git revision `1d680fa14e9a089c92dc0929f869d6757ae91c30`, `wasm/wasm-node.mjs`, published `wasm-node.{mjs,cjs}` and package exports. Archive SHA256 `266866c1b0efd7ca5307fe312411e4f1895b997086fb76f392ec5b60aadf31c8`.
- npm `rolldown@1.2.15`, `dist/shared/binding-BMtuZhvP.mjs` and `@rolldown/binding-wasm32-wasi@1.2.15`, `rolldown-binding.wasi.cjs`. Archive SHA256 `0f4e689f37f168b87605f3b9756b150c63bd1cb52bd04ba5d90e156794625067` and `1e42766faa22460b792a514827441d07ce81e304b447d0679e460cc62d5a9d27`. These publications expose no git revision, so the npm versions and verified archives identify the inspected sources.
- npm `oxc-parser@0.156.0`, `src-js/bindings.js`, and `oxc-transform@0.156.0`, `index.js`. Archive SHA256 `b6378dd65067d16d97bbf472eb1f6896af32485031f9217548e6503e9cbee183` and `7fe71deeeeaca39cc140e547fe62832823140612d4f2a381eca4912942b562c8`. The loaders discover same-version official Wasm binding packages. Stock Vite 8 includes Oxc inside Rolldown and does not require a separate Oxc package.

## Remaining runtime requirements

The stock Node WASI loader uses real `node:wasi`, `node:fs` and worker APIs. It requests shared memory with 16384 initial pages, 1 GiB. Generic napi, shared memory and threads belong to Engines.

The published Rolldown binding pins emnapi core/runtime `2.0.0-alpha.5` and permits `@napi-rs/wasm-runtime` through `~1.2.5`. Version `1.2.6` excludes alpha.5 in its peer metadata. This adapter does not add a dependency override. Selecting the official package does not establish runtime initialization or a passing Vite workflow.

Current source already implements `node:util.parseEnv`. Historical deployed failures do not justify another implementation. Current paired artifact acceptance requires the common producer's verified manifest.

The explicit diagnostic fixture is `tests/install/fixtures/vite8-package-selection`. It tests the named ESM export, imports the actual packages, and checks synchronous CSS output and errors. Run it only after installing with the guest installer; selecting a host-native compiler is not evidence for the Wasm guest.

A native Node 26.12.1 control independently reproduces the stock Node WASI binding's `TypeError: Cannot set properties of undefined (setting 'initWorker')` at `@napi-rs/wasm-runtime/dist/emnapi-plugins.cjs:667`. It selected runtime 1.2.6 and emnapi core/runtime 2.0.0-alpha.5 without overrides. This precedes the separate thread-spawn blocker observed by Waffle after its diagnostic compatibility override.
