#!/usr/bin/env bash
# Build dist/bun.wasm (release, wasm32-wasip1), optimized with wasm-opt.
#   scripts/build.sh            # Bun's transpiler included (default)
#   scripts/build.sh --no-bun-transpiler   # plain-JS-only runtime, smaller
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
# rquickjs-sys looks for wasi-sdk here (otherwise it downloads one).
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"

features=()
if [[ "${1:-}" == "--no-bun-transpiler" ]]; then
  features=(--no-default-features)
fi

cargo build -j "${JOBS:-12}" --release --target wasm32-wasip1 -p bunwasm-cli "${features[@]}"

raw="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
mkdir -p "$root/dist"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals "$raw" -o "$root/dist/bun.wasm"
else
  cp "$raw" "$root/dist/bun.wasm"
fi
printf 'dist/bun.wasm: %s bytes (cargo output: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun.wasm")" "$(stat -c %s "$raw")"
