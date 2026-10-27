#!/usr/bin/env bash
# Build dist/bun-browser.wasm: bunwasm-cli with the host engine (feature engine-host): the
# browser's (or Node's) own JS engine runs user code and the polyfills; the wasm does transpiling,
# resolution, bun build, sqlite and the natives. See docs/engine-browser.md.
#
# Its own target dir: the feature set differs from bun.wasm's (no QuickJS), and both binaries
# are named bun.wasm in cargo's output.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
cd "$root"
bun "$root/scripts/build-wasi-sysroot.ts"
"$root/scripts/sync-crypto.sh"
export CARGO_TARGET_DIR="${BROWSER_CARGO_TARGET_DIR:-${CARGO_TARGET_DIR}-browser}"
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"

guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun "$root/scripts/guest-build-receipt.ts" inputs browser > "$guest_inputs"
"$GUEST_CARGO" build -j "${JOBS:-12}" --release --target wasm32-wasip1 -p bunwasm-cli \
  --no-default-features --features engine-host,bun-transpiler,bun-build
raw="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
mkdir -p "$root/dist"
# -g keeps the name section (function names in wasm stack traces; about +5% gzipped).
wasm-opt -O2 -g --strip-dwarf --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals "$raw" -o "$root/dist/bun-browser.wasm"
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun-browser.wasm" "$guest_inputs"
printf 'dist/bun-browser.wasm: %s bytes (cargo output: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun-browser.wasm")" "$(stat -c %s "$raw")"
