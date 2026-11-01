#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root"
: "${SPIDERMONKEY_NATIVE_DIR:?Set SPIDERMONKEY_NATIVE_DIR to verified G3 native inputs}"
: "${SPIDERMONKEY_ENGINE_BUILD_DIR:?Set SPIDERMONKEY_ENGINE_BUILD_DIR to a private output directory}"
[[ -f "$SPIDERMONKEY_NATIVE_DIR/native-inputs.json" && -f "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a" ]] || {
  echo 'Run spidermonkey/prepare-engine-inputs.ts before building the engine' >&2
  exit 1
}
guest_environment=$(bun scripts/guest-build-receipt.ts environment)
eval "$guest_environment"
engine_environment=$(bun scripts/guest-engine-receipt.ts environment spidermonkey)
eval "$engine_environment"
out="$SPIDERMONKEY_ENGINE_BUILD_DIR"
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/target"
export SPIDERMONKEY_NATIVE_DIR
inputs=''
trap 'rm -f -- "$inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
inputs=$(mktemp "$TMPDIR/bun-spidermonkey-engine-inputs-XXXXXX")
bun scripts/guest-engine-receipt.ts inputs spidermonkey > "$inputs"
side="$out/engine.wasm"
if [[ -e "$side" || -e "$side.engine.json" ]]; then
  bun scripts/guest-engine-receipt.ts verify "$side" "$inputs"
  printf 'SpiderMonkey engine: verified unchanged origin %s\n' "$side"
  exit 0
fi
sysroot=$("$RUSTC" --print sysroot)
"$GUEST_CARGO" fetch --locked --offline --manifest-path "$sysroot/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1
"$GUEST_CARGO" build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 \
  -j "${CARGO_BUILD_JOBS:-4}" -p bunwasm-engine-spidermonkey
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC -O2 \
  -fno-builtin-malloc -fno-builtin-free -DENGINE_CTOR_VALUE=spidermonkey_ctor_value \
  -c scripts/src/engine-init.c -o "$out/engine-init.o"
"$WASI_SDK_PATH/bin/wasm-ld" --shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined \
  --export=spidermonkey_ctor_value --export=__stack_pointer --export=__wasm_call_ctors \
  --export=spidermonkey_register --export=spidermonkey_run -Map="$out/engine-link.map" \
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_spidermonkey.a"
node scripts/src/engine-explicit-init.ts spidermonkey "$out/engine.implicit.wasm" "$side"
wasm-tools validate "$side"
bun scripts/side-import-delta.ts "$side" > "$out/import-delta.txt"
bun scripts/guest-engine-receipt.ts write "$side" "$inputs"
