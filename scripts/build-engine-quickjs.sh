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
# Core functions the side's Rust std calls and then reads errno for (group-errno.c).
group_errno_wraps=()
case "$profile" in
  split) ;;
  shared-group)
    bun "$root/scripts/src/program-profile.ts" environment quickjs > /dev/null
    group_errno_wraps=(write writev clock_gettime getcwd)
    link_profile=(--shared-memory)
    for name in "${group_errno_wraps[@]}"; do link_profile+=("--wrap=$name"); done
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
archive="$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_quickjs.a"
group_objects=()
if [[ ${#group_errno_wraps[@]} -gt 0 ]]; then
  "$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC "${init_profile[@]}" -O2 \
    -c "$root/crates/bunwasm-engine-quickjs/group-errno.c" -o "$out/group-errno.o"
  group_objects=("$out/group-errno.o")
  # Every errno-setting core function the side's std imports must be wrapped, or std would read
  # this side's errno after a core call that set only the core's.
  inert=" abort free malloc realloc posix_memalign strlen getenv strerror_r errno _CLOCK_MONOTONIC __stack_pointer ${group_errno_wraps[*]} "
  std_members=$("$WASI_SDK_PATH/bin/llvm-ar" t "$archive" | grep -F '.std-' || true)
  [[ -n "$std_members" ]] || { echo "error: no std objects found in $archive" >&2; exit 1; }
  rm -rf "$out/std-members" && mkdir "$out/std-members"
  (cd "$out/std-members" && "$WASI_SDK_PATH/bin/llvm-ar" x "$archive" $std_members)
  std_undefined=$("$WASI_SDK_PATH/bin/llvm-nm" -u "$out"/std-members/* | awk 'NF {print $NF}' | sort -u)
  rm -rf "$out/std-members"
  std_imports=$(comm -12 <(printf '%s\n' "$std_undefined") <(sort -u "$root/scripts/quickjs-core-exports.txt"))
  [[ -n "$std_imports" ]] || { echo "error: no core imports found in the side's std objects" >&2; exit 1; }
  unwrapped=$(while read -r name; do [[ "$inert" == *" $name "* ]] || echo "$name"; done <<< "$std_imports")
  [[ -z "$unwrapped" ]] || { echo "error: side std imports errno-setting core functions without an errno wrap: $unwrapped" >&2; exit 1; }
fi
exports=(quickjs_ctor_value __stack_pointer __wasm_call_ctors quickjs_memory_telemetry quickjs_memory_telemetry_refresh)
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
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "${group_objects[@]}" "$archive"
node "$root/scripts/src/engine-explicit-init.ts" quickjs "$out/engine.implicit.wasm" "$out/engine.wasm" "${explicit_profile[@]}"
wasm-tools validate "$out/engine.wasm"
if [[ -n "$inputs" ]]; then
  bun "$root/scripts/guest-engine-receipt.ts" write "$out/engine.wasm" "$inputs"
fi
