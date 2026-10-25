#!/usr/bin/env bash
# Build dist/bun.wasm (release, wasm32-wasip1), optimized with wasm-opt.
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

features=()
if [[ "${1:-}" == "--no-bun-transpiler" ]]; then
  features=(--no-default-features)
fi

guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
guest_build=quickjs
if [[ "${1:-}" == "--no-bun-transpiler" ]]; then guest_build=quickjs-minimal; fi
bun "$root/scripts/guest-build-receipt.ts" inputs "$guest_build" > "$guest_inputs"
"$GUEST_CARGO" build -j "${JOBS:-12}" --release --target wasm32-wasip1 -p bunwasm-cli "${features[@]}"

if [[ "${1:-}" != "--no-bun-transpiler" ]]; then
  "$root/scripts/test-transpiler-example.sh"
fi

raw="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
mkdir -p "$root/dist"
if command -v wasm-opt >/dev/null; then
  # -g keeps the name section (function names in wasm stack traces; about +5% gzipped); there is
  # no DWARF to strip in release builds, --strip-dwarf makes sure.
  wasm-opt -O2 -g --strip-dwarf --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$raw" -o "$root/dist/bun.wasm"
else
  cp "$raw" "$root/dist/bun.wasm"
fi
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun.wasm" "$guest_inputs"
printf 'dist/bun.wasm: %s bytes (cargo output: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun.wasm")" "$(stat -c %s "$raw")"
