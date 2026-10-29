#!/usr/bin/env bash
# Compose the verified common core with one Hermes program side (opt-in; no default build).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/hermes/common.sh"
cd "$root"
bun "$root/scripts/build-wasi-sysroot.ts"
"$root/scripts/sync-crypto.sh"
[[ -f "$HERMES_LIB" ]] || {
  echo "error: $HERMES_LIB missing: run HERMES_BUILD_DIR=$HERMES_BUILD_DIR hermes/build.sh" >&2
  exit 1
}
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun "$root/scripts/guest-build-receipt.ts" inputs hermes > "$guest_inputs"
export BUN_CORE_BUILD_DIR="${BUN_CORE_BUILD_DIR:-$CARGO_TARGET_DIR/split-common}"
export CARGO_BUILD_JOBS="${JOBS:-4}"
export HERMES_ENGINE_BUILD_DIR="${HERMES_ENGINE_BUILD_DIR:-$HERMES_BUILD_DIR/engine}"
bun "$root/scripts/guest-core-receipt.ts" prepare hermes "$BUN_CORE_BUILD_DIR/bun-core.wasm" "$HERMES_ENGINE_BUILD_DIR/engine.wasm"
"$root/scripts/build-bun-core.sh"
mkdir -p "$root/dist"
bun "$root/scripts/guest-core-receipt.ts" tag "$BUN_CORE_BUILD_DIR/bun-core.wasm" hermes "$root/dist/bun-hermes.wasm"
"$root/scripts/build-engine-hermes.sh"
cp "$HERMES_ENGINE_BUILD_DIR/engine.wasm" "$root/dist/hermes-engine.wasm"
cp "$HERMES_ENGINE_BUILD_DIR/engine.wasm.engine.json" "$root/dist/hermes-engine.wasm.engine.json"
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun-hermes.wasm" "$guest_inputs"
printf 'dist/bun-hermes.wasm: %s bytes (common core: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun-hermes.wasm")" "$(stat -c %s "$BUN_CORE_BUILD_DIR/bun-core.wasm")"
printf 'dist/hermes-engine.wasm: %s bytes\n' "$(stat -c %s "$root/dist/hermes-engine.wasm")"
