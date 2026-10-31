# Hermes engine program

Hermes is an opt-in third engine program: the common core (`bun-hermes.wasm`, tagged `hermes`)
plus `hermes-engine.wasm`, a `wasm-ld --shared` side that compiles the shared engine driver with
`crates/bunwasm-engine-hermes/src/vm.rs` over the Hermes VM and its C shim (`crates/bunwasm-hermes`).
No default build, menu entry or CI job includes it.

Build and run (native launcher):

```sh
source env.sh
export HERMES_BUILD_DIR=/work/tmp/bun-wasm-hermes-<lane>
hermes/build.sh                      # the VM library
scripts/build-bun-hermes.sh          # dist/bun-hermes.wasm + dist/hermes-engine.wasm
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm dist/bun-hermes.wasm -- -e 'console.log(1 + 1)'
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm dist/bun-hermes.wasm -- run tests/hermes/hello.cts
```

Settings: `BUN_WASM_HERMES_OPT` (`none` default, `user`, `all`) and
`BUN_WASM_HERMES_MAX_HEAP_MIB` (default 384). Heap exhaustion is fatal (exit 134).

Provenance: [engine program](bun-patches/hermes-engine-program.md).
## Hosts

The browser loader accepts `?engine=hermes` when the web build contains both files.
`HERMES_WASM` selects the core for `web/build.ts`; its companion must be in the same directory.
Hermes stays outside the engine menu and default adapter registrations.

Package installations select Hermes explicitly:

```ts
await installBunAdapters(runtime, { engine: "hermes", asset: hermesPair, workerUrl });
```

`hermesPair` has `kind: "hermes"` and the usual integrity descriptors for `core` and `side`.
The package rejects a different core declaration. Executables live in `/opt/bun/hermes/bin`.
The Node/Bun fixture host accepts `--wasm PATH` and optional `--engine hermes=PATH`.

`bun scripts/hermes-hosts.ts dist/bun-hermes.wasm RESULT.json` checks package loading,
actual Node and Bun fixture execution, and the browser loader in headless Chromium.
`--node-only` omits Chromium; `--metadata-only` checks direct `import.meta.main` instead of
repeating hello and imported-module checks. The runner removes its temporary host resources.
Hermes VM telemetry is unavailable and stays null; core capacity is reported separately.

The path-filtered Hermes CI job reuses the native job's common core, sysroot and launcher.
It builds the opt-in side and runs native eval/serve and Node/Bun module smoke checks.
