#!/usr/bin/env bash
# Bare smoke test of the Hermes VM library (hermes/build.sh first): builds
# crates/bunwasm-hermes/examples/smoke.rs for wasm32-wasip1 against it, checks that the module
# imports only WASI preview 1, and runs it under wasmtime.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ -f "$HERMES_LIB" ]] || {
  echo "error: $HERMES_LIB missing; run HERMES_BUILD_DIR=$HERMES_BUILD_DIR hermes/build.sh." >&2
  exit 1
}
build_hermes_lib
export HERMES_BUILD_DIR
export CARGO_TARGET_DIR="${HERMES_CARGO_TARGET_DIR:-$HERMES_BUILD_DIR/target}"
cd "$REPO"
cargo build --locked --release -j "$JOBS" --target wasm32-wasip1 -p bunwasm-hermes --example smoke --features standalone
smoke="$CARGO_TARGET_DIR/wasm32-wasip1/release/examples/smoke.wasm"
node "$HERMES_SRC/check-build.ts" "$HERMES_BUILD_DIR" "$smoke"
# Match bunwasm-host's 16 MiB native Wasm stack limit.
timeout 60s wasmtime run -W max-wasm-stack=16777216 "$smoke"
# The wasmtime CLI rejects guest statuses >=126; WASI returnOnExit preserves 134.
timeout 60s node --disable-warning=ExperimentalWarning "$HERMES_SRC/check-fatal.ts" "$smoke" \
  > "$HERMES_BUILD_DIR/oom.stdout" 2> "$HERMES_BUILD_DIR/oom.stderr"
grep -q 'Hermes fatal:' "$HERMES_BUILD_DIR/oom.stderr"
cat "$HERMES_BUILD_DIR/oom.stdout"
