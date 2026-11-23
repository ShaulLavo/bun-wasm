#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
cd "$root"
bun "$root/scripts/build-wasi-sysroot.ts"
export CARGO_TARGET_DIR="${TOOLS_CARGO_TARGET_DIR:-${CARGO_TARGET_DIR}-tools}"
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun "$root/scripts/guest-build-receipt.ts" inputs tools > "$guest_inputs"
"$GUEST_CARGO" build --locked -j "${JOBS:-12}" --release --target wasm32-wasip1 -p bunwasm-tools
mkdir -p "$root/dist"
# -g keeps the name section in the unshipped dist/bun-tools.named.wasm, for profilers; the shipped
# dist/bun-tools.wasm drops it (about 3 MB raw; scripts/wasm-name-sections.ts).
bun "$root/scripts/optimize-tools.ts" "$CARGO_TARGET_DIR/wasm32-wasip1/release/bun-tools.wasm" \
  "$root/dist/bun-tools.named.wasm" "$CARGO_TARGET_DIR/tools-optimized" -- \
  -O2 -g --strip-dwarf --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals
bun "$root/scripts/wasm-name-sections.ts" strip "$root/dist/bun-tools.named.wasm" "$root/dist/bun-tools.wasm"
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun-tools.wasm" "$guest_inputs"
printf 'dist/bun-tools.wasm: %s bytes, named copy %s bytes\n' \
  "$(stat -c %s "$root/dist/bun-tools.wasm")" "$(stat -c %s "$root/dist/bun-tools.named.wasm")"
