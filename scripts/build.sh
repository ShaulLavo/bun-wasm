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
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
guest_build=quickjs
if [[ "${1:-}" == "--no-bun-transpiler" ]]; then guest_build=quickjs-minimal; fi
bun "$root/scripts/guest-build-receipt.ts" inputs "$guest_build" > "$guest_inputs"
export BUN_CORE_BUILD_DIR="${BUN_CORE_BUILD_DIR:-$CARGO_TARGET_DIR/split-quickjs}"
export CARGO_BUILD_JOBS="${JOBS:-4}"
"$root/scripts/build-bun-core.sh" "$@"

if [[ "${1:-}" != "--no-bun-transpiler" ]]; then
  "$root/scripts/test-transpiler-example.sh"
fi

raw="$BUN_CORE_BUILD_DIR/bun-core.wasm"
mkdir -p "$root/dist"
if command -v wasm-opt >/dev/null; then
  # -g keeps the name section (function names in wasm stack traces; about +5% gzipped); there is
  # no DWARF to strip in release builds, --strip-dwarf makes sure.
  wasm-opt -O2 -g --strip-dwarf --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$raw" -o "$root/dist/bun.wasm"
else
  cp "$raw" "$root/dist/bun.wasm"
fi
cp "$BUN_CORE_BUILD_DIR/quickjs.wasm" "$root/dist/quickjs.wasm"
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun.wasm" "$guest_inputs"
printf 'dist/bun.wasm: %s bytes (cargo output: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun.wasm")" "$(stat -c %s "$raw")"
printf "dist/quickjs.wasm: %s bytes\n" "$(stat -c %s "$root/dist/quickjs.wasm")"
