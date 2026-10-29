#!/usr/bin/env bash
# Bare smoke test of the Hermes VM library (scripts/build-hermes.sh first): builds
# crates/bunwasm-hermes/examples/smoke.rs for wasm32-wasip1 against it, checks that the module
# imports only WASI preview 1, and runs it under wasmtime.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ -f "$HERMES_LIB" ]] || {
  echo "error: $HERMES_LIB missing; run HERMES_BUILD_DIR=$HERMES_BUILD_DIR scripts/build-hermes.sh." >&2
  exit 1
}
build_hermes_lib
export HERMES_BUILD_DIR
export CARGO_TARGET_DIR="${HERMES_CARGO_TARGET_DIR:-$HERMES_BUILD_DIR/target}"
cd "$REPO"
cargo build --locked --release -j "$JOBS" --target wasm32-wasip1 -p bunwasm-hermes --example smoke --features standalone
smoke="$CARGO_TARGET_DIR/wasm32-wasip1/release/examples/smoke.wasm"
foreign=$(bun -e 'const m = new WebAssembly.Module(await Bun.file(process.argv[1]).bytes());
  console.log(WebAssembly.Module.imports(m).filter(i => i.module !== "wasi_snapshot_preview1").map(i => `${i.module}.${i.name}`).join("\n"))' "$smoke")
if [[ -n "$foreign" ]]; then
  echo "error: smoke.wasm imports outside wasi_snapshot_preview1:" >&2
  echo "$foreign" >&2
  exit 1
fi
printf 'smoke.wasm: %s bytes, imports only wasi_snapshot_preview1\n' "$(stat -c %s "$smoke")"
wasmtime run "$smoke"
