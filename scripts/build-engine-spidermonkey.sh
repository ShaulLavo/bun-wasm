#!/usr/bin/env bash
# Build only the experimental SpiderMonkey side. Pairing and receipts belong to the side/core adapter.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root"
jobs=${CARGO_BUILD_JOBS:-4}
[[ "$jobs" =~ ^[1-4]$ ]] || { echo "SpiderMonkey qualification allows one to four compiler jobs" >&2; exit 1; }
[[ "${BUN_WASM_PROGRAM_PROFILE:-split}" == split ]] || { echo "SpiderMonkey is split-only" >&2; exit 1; }
: "${SPIDERMONKEY_NATIVE_DIR:?Set SPIDERMONKEY_NATIVE_DIR to a parent-admitted N1 input directory}"
: "${SPIDERMONKEY_ENGINE_BUILD_DIR:?Set SPIDERMONKEY_ENGINE_BUILD_DIR to a private output directory}"
bun scripts/spidermonkey-side-core-receipt.ts verify-native "$SPIDERMONKEY_NATIVE_DIR"
guest_environment=$(bun scripts/guest-build-receipt.ts environment)
eval "$guest_environment"
sysroot=${BUN_WASM_SYSROOT:?Set BUN_WASM_SYSROOT}
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C relocation-model=pic -C panic=abort -C link-self-contained=no"
export CFLAGS_wasm32_wasip1="--sysroot=$sysroot -fPIC"
export CXXFLAGS_wasm32_wasip1="--sysroot=$sysroot -fPIC -fno-exceptions"
out=$(mkdir -p "$SPIDERMONKEY_ENGINE_BUILD_DIR" && cd "$SPIDERMONKEY_ENGINE_BUILD_DIR" && pwd)
export CARGO_TARGET_DIR="$out/target"
export SPIDERMONKEY_NATIVE_DIR
# The Rust build script still has a legacy static-library basename. This private link name
# points at the admitted bytes and creates no receipt or historical G2 identity.
if [[ -e "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a" || -L "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a" ]]; then
  [[ "$(readlink "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a")" == libspidermonkey_bunwasm.a ]] || exit 1
else
  ln -s libspidermonkey_bunwasm.a "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a"
fi
inputs="$out/inputs.json"
[[ ! -e "$inputs" ]] || { echo "Refusing an existing side build input claim" >&2; exit 1; }
bun scripts/spidermonkey-side-core-receipt.ts inputs "$root" "$SPIDERMONKEY_NATIVE_DIR" > "$inputs"
side="$out/engine.wasm"
if [[ -e "$side" ]]; then
  echo "Refusing to overwrite existing experimental side: $side" >&2
  exit 1
fi
sysroot_rust=$($RUSTC --print sysroot)
$GUEST_CARGO fetch --locked --offline --manifest-path "$sysroot_rust/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1
$GUEST_CARGO build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j "$jobs" -p bunwasm-engine-spidermonkey
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$sysroot" -fPIC -O2 -fno-builtin-malloc -fno-builtin-free \
  -DENGINE_CTOR_VALUE=spidermonkey_ctor_value -c scripts/src/engine-init.c -o "$out/engine-init.o"
"$WASI_SDK_PATH/bin/wasm-ld" --shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined --export=spidermonkey_ctor_value \
  --export=__stack_pointer --export=__wasm_call_ctors --export=spidermonkey_register --export=spidermonkey_run \
  -Map="$out/engine-link.map" -o "$out/engine.implicit.wasm" "$out/engine-init.o" \
  "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_spidermonkey.a"
bun scripts/spidermonkey-side-core-receipt.ts convert-side "$out/engine.implicit.wasm" "$side"
wasm-tools validate "$side"
bun scripts/spidermonkey-side-core-receipt.ts inputs "$root" "$SPIDERMONKEY_NATIVE_DIR" > "$out/inputs-after.json"
cmp "$inputs" "$out/inputs-after.json"
