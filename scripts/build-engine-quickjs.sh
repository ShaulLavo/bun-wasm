#!/usr/bin/env bash
# Actual rquickjs shared module. The registered RUN entry owns the VM and application driver.
# Contract and provenance: docs/bun-patches/quickjs-shared-module.md.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source env.sh
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
out=${QUICKJS_BUILD_DIR:?Set QUICKJS_BUILD_DIR to a lane-private build directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/target"
# QUICKJS_PROFILE=shared-group: the opt-in memory-group side (docs/shared-group-profile.md).
profile=${QUICKJS_PROFILE:-split}
link_profile=()
init_profile=()
explicit_profile=()
case "$profile" in
  split) ;;
  shared-group)
    bun "$root/scripts/src/program-profile.ts" environment quickjs > /dev/null
    link_profile=(--shared-memory)
    init_profile=(-matomics -mbulk-memory -mmutable-globals)
    explicit_profile=(--group)
    ;;
  *) echo "error: unsupported QUICKJS_PROFILE $profile" >&2; exit 2 ;;
esac
profile_argument=()
[[ "$profile" == split ]] || profile_argument=("$profile")
engine_environment=$(bun "$root/scripts/guest-engine-receipt.ts" environment quickjs "${profile_argument[@]}")
eval "$engine_environment"
inputs=''
trap 'if [[ -n "$inputs" ]]; then rm -f -- "$inputs"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${QUICKJS_SMOKE_EXPORTS:-0}" == 1 ]]; then
  if [[ -e "$out/engine.wasm.engine.json" ]]; then
    echo 'error: use a separate QUICKJS_BUILD_DIR for smoke exports' >&2
    exit 1
  fi
else
  inputs=$(mktemp "$TMPDIR/bun-quickjs-engine-inputs-XXXXXX")
  bun "$root/scripts/guest-engine-receipt.ts" inputs quickjs "${profile_argument[@]}" > "$inputs"
  if [[ -e "$out/engine.wasm" || -e "$out/engine.wasm.engine.json" ]]; then
    bun "$root/scripts/guest-engine-receipt.ts" verify "$out/engine.wasm" "$inputs"
    printf 'QuickJS engine: verified unchanged origin %s\n' "$out/engine.wasm"
    exit 0
  fi
fi
sysroot=$("$RUSTC" --print sysroot)
"$GUEST_CARGO" fetch --locked --offline --manifest-path "$sysroot/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1
"$GUEST_CARGO" build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 \
  -j "${CARGO_BUILD_JOBS:-4}" -p bunwasm-engine-quickjs
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC "${init_profile[@]}" -O2 -fno-builtin-malloc -fno-builtin-free \
  -DENGINE_CTOR_VALUE=quickjs_ctor_value -c "$root/scripts/src/engine-init.c" -o "$out/engine-init.o"
exports=(quickjs_ctor_value __stack_pointer __wasm_call_ctors)
if [[ "${QUICKJS_SMOKE_EXPORTS:-0}" == 1 ]]; then
  exports+=(quickjs_helpers_smoke quickjs_link_smoke quickjs_rust_alloc quickjs_rust_free quickjs_rust_realloc
    quickjs_stack_reenter quickjs_interrupt_smoke quickjs_stack_guard_smoke)
else
  exports+=(quickjs_register quickjs_run)
fi
args=()
for name in "${exports[@]}"; do args+=("--export=$name"); done
"$WASI_SDK_PATH/bin/wasm-ld" --shared "${link_profile[@]}" --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined "${args[@]}" \
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_quickjs.a"
node "$root/scripts/src/engine-explicit-init.ts" quickjs "$out/engine.implicit.wasm" "$out/engine.wasm" "${explicit_profile[@]}"
wasm-tools validate "$out/engine.wasm"
if [[ -n "$inputs" ]]; then
  bun "$root/scripts/guest-engine-receipt.ts" write "$out/engine.wasm" "$inputs"
fi
