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
profile=$JSC_PROFILE
link_profile=()
init_profile=()
explicit_profile=()
# Core functions the side's Rust std calls and then reads errno for (group-errno.c).
group_errno_wraps=()
if [[ "$profile" == shared-group ]]; then
  bun "$root/scripts/src/program-profile.ts" environment jsc > /dev/null
  group_errno_wraps=(write writev clock_gettime getcwd)
  link_profile=(--shared-memory)
  for name in "${group_errno_wraps[@]}"; do link_profile+=("--wrap=$name"); done
  init_profile=(-matomics -mbulk-memory -mmutable-globals)
  explicit_profile=(--group)
fi
profile_argument=()
[[ "$profile" == split ]] || profile_argument=("$profile")
engine_environment=$(bun "$root/scripts/guest-engine-receipt.ts" environment jsc "${profile_argument[@]}")
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
bun "$root/scripts/guest-engine-receipt.ts" inputs jsc "${profile_argument[@]}" > "$inputs"
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
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC "${init_profile[@]}" -O2 \
  -fno-builtin-malloc -fno-builtin-free -DENGINE_CTOR_VALUE=jsc_ctor_value -c \
  "$root/scripts/src/engine-init.c" -o "$out/engine-init.o"
group_objects=()
if [[ ${#group_errno_wraps[@]} -gt 0 ]]; then
  "$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC "${init_profile[@]}" -O2 \
    -c "$root/crates/bunwasm-engine-quickjs/group-errno.c" -o "$out/group-errno.o"
  group_objects=("$out/group-errno.o")
  # shellcheck source=scripts/src/group-errno-wraps.sh
  source "$root/scripts/src/group-errno-wraps.sh"
  check_group_errno_wraps "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_jsc.a" "$out" "${group_errno_wraps[@]}"
fi
# Undefined symbols are emitted as imports, never accepted as proof of closure.
# The separately released real gate must admit every retained import against core.
"$WASI_SDK_PATH/bin/wasm-ld" --shared "${link_profile[@]}" --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined \
  --export=jsc_ctor_value --export=__stack_pointer --export=__wasm_call_ctors \
  --export=jsc_register --export=jsc_run \
  --export=jsc_memory_telemetry --export=jsc_memory_telemetry_refresh --export=jsc_allocation_boundary -Map="$out/engine-link.map" \
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "${group_objects[@]}" "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_jsc.a"
"$root/jsc/finalize.sh" "$out/engine.implicit.wasm" "$out/engine.spilled.wasm"
node "$root/scripts/src/engine-explicit-init.ts" jsc "$out/engine.spilled.wasm" "$side" "${explicit_profile[@]}"
wasm-tools validate "$side"
bun "$root/scripts/guest-engine-receipt.ts" write "$side" "$inputs"
