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
