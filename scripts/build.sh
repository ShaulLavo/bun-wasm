#!/usr/bin/env bash
# Build the default matched dist/bun.wasm core and dist/quickjs.wasm engine.
#   scripts/build.sh            # Bun's transpiler included (default)
#   scripts/build.sh --no-bun-transpiler   # plain-JS-only runtime, smaller
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
cd "$root"
bun "$root/scripts/build-wasi-sysroot.ts"
"$root/scripts/sync-crypto.sh"
# rquickjs-sys looks for wasi-sdk here (otherwise it downloads one).
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"

guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
guest_build=quickjs
if [[ "${1:-}" == "--no-bun-transpiler" ]]; then guest_build=quickjs-minimal; fi
bun "$root/scripts/guest-build-receipt.ts" inputs "$guest_build" > "$guest_inputs"
export BUN_CORE_BUILD_DIR="${BUN_CORE_BUILD_DIR:-$CARGO_TARGET_DIR/split-common}"
export CARGO_BUILD_JOBS="${JOBS:-4}"
"$root/scripts/build-bun-core.sh" "$@"
mkdir -p "$root/dist"
bun "$root/scripts/guest-core-receipt.ts" tag "$BUN_CORE_BUILD_DIR/bun-core.wasm" quickjs "$root/dist/bun.wasm"
QUICKJS_BUILD_DIR="$BUN_CORE_BUILD_DIR/quickjs" "$root/scripts/build-engine-quickjs.sh"
cp "$BUN_CORE_BUILD_DIR/quickjs/engine.wasm" "$BUN_CORE_BUILD_DIR/quickjs.wasm"

if [[ "${1:-}" != "--no-bun-transpiler" ]]; then
  "$root/scripts/test-transpiler-example.sh"
fi

raw="$BUN_CORE_BUILD_DIR/bun-core.wasm"
cp "$BUN_CORE_BUILD_DIR/quickjs.wasm" "$root/dist/quickjs.wasm"
cp "$BUN_CORE_BUILD_DIR/quickjs/engine.wasm.engine.json" "$root/dist/quickjs.wasm.engine.json"
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun.wasm" "$guest_inputs"
printf 'dist/bun.wasm: %s bytes (common core: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun.wasm")" "$(stat -c %s "$raw")"
printf "dist/quickjs.wasm: %s bytes\n" "$(stat -c %s "$root/dist/quickjs.wasm")"
