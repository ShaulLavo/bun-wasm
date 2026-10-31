#!/usr/bin/env bash
# Build one retained JSC program side. Real PIC/import/GC admission is a separate gate.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/jsc/common.sh"
cd "$root"
check_jsc_inputs_stamp
if ! LC_ALL=C grep -qa BUN_WASM_STACK_KIB "$JSC_OBJ/lib/libWTF.a"; then
  echo "error: $JSC_OBJ/lib/libWTF.a lacks the JSC StackBounds budget" >&2
  exit 1
fi
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
engine_environment=$(bun "$root/scripts/guest-engine-receipt.ts" environment jsc)
eval "$engine_environment"
out=${JSC_ENGINE_BUILD_DIR:?Set JSC_ENGINE_BUILD_DIR to a lane-private build directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/target"
export JSC_BUILD_DIR
export WASI_SDK="$WASI_SDK_PATH"
inputs=''
trap 'rm -f -- "$inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
inputs=$(mktemp "$TMPDIR/bun-jsc-engine-inputs-XXXXXX")
bun "$root/scripts/guest-engine-receipt.ts" inputs jsc > "$inputs"
side="$out/engine.wasm"
if [[ -e "$side" || -e "$side.engine.json" ]]; then
  bun "$root/scripts/guest-engine-receipt.ts" verify "$side" "$inputs"
  printf 'JSC engine: verified unchanged origin %s\n' "$side"
  exit 0
fi
sysroot=$("$RUSTC" --print sysroot)
"$GUEST_CARGO" fetch --locked --offline --manifest-path "$sysroot/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1
PATH="$(dirname "$(command -v node)"):$PATH_NO_BINARYEN" $CAGE "$GUEST_CARGO" build --locked --offline \
  -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j "${CARGO_BUILD_JOBS:-$JOBS}" -p bunwasm-engine-jsc
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC -O2 \
  -fno-builtin-malloc -fno-builtin-free -DENGINE_CTOR_VALUE=jsc_ctor_value -c \
  "$root/scripts/src/engine-init.c" -o "$out/engine-init.o"
# Undefined symbols are emitted as imports, never accepted as proof of closure.
# The separately released real gate must admit every retained import against core.
"$WASI_SDK_PATH/bin/wasm-ld" --shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined \
  --export=jsc_ctor_value --export=__stack_pointer --export=__wasm_call_ctors \
  --export=jsc_register --export=jsc_run \
  --export=jsc_memory_telemetry --export=jsc_memory_telemetry_refresh -Map="$out/engine-link.map" \
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_jsc.a"
"$root/jsc/finalize.sh" "$out/engine.implicit.wasm" "$out/engine.spilled.wasm"
node "$root/scripts/src/engine-explicit-init.ts" jsc "$out/engine.spilled.wasm" "$side"
wasm-tools validate "$side"
bun "$root/scripts/guest-engine-receipt.ts" write "$side" "$inputs"
