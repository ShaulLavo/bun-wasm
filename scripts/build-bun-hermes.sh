#!/usr/bin/env bash
# Build dist/bun-hermes.wasm: bunwasm-cli with the Hermes engine (feature engine-hermes,
# crates/bunwasm-runtime/src/engine_hermes.rs) linked with the static VM from
# scripts/build-hermes.sh, then wasm-opt like dist/bun.wasm. Same runtime and polyfills.
# Its own target dir, so the default build's cache is untouched.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/hermes/common.sh"
cd "$root"
bun "$root/scripts/build-wasi-sysroot.ts"
"$root/scripts/sync-crypto.sh"
[[ -f "$HERMES_LIB" ]] || {
  echo "error: $HERMES_LIB missing; run HERMES_BUILD_DIR=$HERMES_BUILD_DIR scripts/build-hermes.sh." >&2
  exit 1
}
build_hermes_lib
export HERMES_BUILD_DIR
export CARGO_TARGET_DIR="${HERMES_CARGO_TARGET_DIR:-$HERMES_BUILD_DIR/target}"
# sqlite's cc build uses the same wasi-sdk.
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
$CAGE "$GUEST_CARGO" build -j "$JOBS" --release --target wasm32-wasip1 -p bunwasm-cli \
  --no-default-features --features engine-hermes,bun-transpiler,bun-build
raw="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
mkdir -p "$root/dist"
wasm-opt -O2 -g --strip-dwarf --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals "$raw" -o "$root/dist/bun-hermes.wasm"
printf 'dist/bun-hermes.wasm: %s bytes (cargo output: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun-hermes.wasm")" "$(stat -c %s "$raw")"
