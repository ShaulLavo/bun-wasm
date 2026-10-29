#!/usr/bin/env bash
# Build the Hermes program side (hermes-engine.wasm) against the VM library from hermes/build.sh.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/hermes/common.sh"
cd "$root"
[[ -f "$HERMES_LIB" ]] || {
  echo "error: $HERMES_LIB missing: run HERMES_BUILD_DIR=$HERMES_BUILD_DIR hermes/build.sh" >&2
  exit 1
}
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
engine_environment=$(bun "$root/scripts/guest-engine-receipt.ts" environment hermes)
eval "$engine_environment"
out=${HERMES_ENGINE_BUILD_DIR:?Set HERMES_ENGINE_BUILD_DIR to a lane-private build directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/target"
export HERMES_BUILD_DIR
inputs=''
trap 'rm -f -- "$inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
inputs=$(mktemp "$TMPDIR/bun-hermes-engine-inputs-XXXXXX")
bun "$root/scripts/guest-engine-receipt.ts" inputs hermes > "$inputs"
side="$out/engine.wasm"
if [[ -e "$side" || -e "$side.engine.json" ]]; then
  bun "$root/scripts/guest-engine-receipt.ts" verify "$side" "$inputs"
  printf 'Hermes engine: verified unchanged origin %s\n' "$side"
  exit 0
fi
sysroot=$("$RUSTC" --print sysroot)
"$GUEST_CARGO" fetch --locked --offline --manifest-path "$sysroot/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1
PATH="$(dirname "$(command -v node)"):$(echo "$PATH" | tr ':' '\n' | grep -v binaryen | paste -sd:)" $CAGE "$GUEST_CARGO" build --locked --offline \
  -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j "${CARGO_BUILD_JOBS:-$JOBS}" -p bunwasm-engine-hermes
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC -O2 \
  -fno-builtin-malloc -fno-builtin-free -DENGINE_CTOR_VALUE=hermes_ctor_value -c \
  "$root/scripts/src/engine-init.c" -o "$out/engine-init.o"
# Undefined symbols become imports; the launcher admits each one against the core's exports.
"$WASI_SDK_PATH/bin/wasm-ld" --shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined \
  --export=hermes_ctor_value --export=__stack_pointer --export=__wasm_call_ctors \
  --export=hermes_register --export=hermes_run -Map="$out/engine-link.map" \
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_hermes.a"
node "$root/scripts/src/engine-explicit-init.ts" hermes "$out/engine.implicit.wasm" "$side"
wasm-tools validate "$side"
# The VM and libc++ build without C++ exceptions: no exception tags may reach the side.
tags=$(wasm-tools print "$side" | grep -c '(tag ' || true)
if [[ "$tags" != 0 ]]; then
  echo "error: $side declares $tags exception tags" >&2
  exit 1
fi
bun "$root/scripts/hermes-import-delta.ts" "$side" > "$out/import-delta.txt" || { cat "$out/import-delta.txt" >&2; exit 1; }
bun "$root/scripts/guest-engine-receipt.ts" write "$side" "$inputs"
