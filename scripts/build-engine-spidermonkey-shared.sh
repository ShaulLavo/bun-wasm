#!/usr/bin/env bash
# Build the experimental SpiderMonkey side for the shared-group profile: an atomics side over the
# imported group memory, linked against the library spidermonkey/build-shared-group.sh staged.
# The split side stays with build-engine-spidermonkey.sh and its admitted inputs.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root"
jobs=${CARGO_BUILD_JOBS:-4}
[[ "$jobs" =~ ^[1-4]$ ]] || { echo "SpiderMonkey qualification allows one to four compiler jobs" >&2; exit 1; }
: "${SPIDERMONKEY_NATIVE_DIR:?Set SPIDERMONKEY_NATIVE_DIR to the native directory of a shared-group library build}"
: "${SPIDERMONKEY_LIBCXX_DIR:?Set SPIDERMONKEY_LIBCXX_DIR to the atomics libc++ lib directory (jsc/build-libcxx.sh)}"
: "${SPIDERMONKEY_ENGINE_BUILD_DIR:?Set SPIDERMONKEY_ENGINE_BUILD_DIR to a private output directory}"
[[ -f "$SPIDERMONKEY_NATIVE_DIR/shared-group-library.json" ]] || { echo "Not a shared-group SpiderMonkey library: $SPIDERMONKEY_NATIVE_DIR" >&2; exit 1; }
for archive in libc++.a libc++abi.a; do
  [[ -f "$SPIDERMONKEY_LIBCXX_DIR/$archive" ]] || { echo "Missing atomics $archive in $SPIDERMONKEY_LIBCXX_DIR" >&2; exit 1; }
done
guest_environment=$(bun scripts/guest-build-receipt.ts environment)
eval "$guest_environment"
# Every guest object of a group program shares one compiler environment. This also verifies
# that the sysroot is the shared-pic one.
profile_environment=$(bun scripts/src/program-profile.ts environment core)
eval "$profile_environment"
sysroot=$BUN_WASM_SYSROOT
features=(-matomics -mbulk-memory -mmutable-globals)
# Core functions the side's Rust std calls and then reads errno for (group-errno.c).
group_errno_wraps=(write writev clock_gettime getcwd)
out=$(mkdir -p "$SPIDERMONKEY_ENGINE_BUILD_DIR" && cd "$SPIDERMONKEY_ENGINE_BUILD_DIR" && pwd)
export CARGO_TARGET_DIR="$out/target"
export SPIDERMONKEY_NATIVE_DIR SPIDERMONKEY_LIBCXX_DIR
# The Rust build script links the library under its legacy basename.
if [[ ! -e "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a" ]]; then
  ln -s libspidermonkey_bunwasm.a "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a"
fi
[[ "$(readlink "$SPIDERMONKEY_NATIVE_DIR/libspidermonkey_g2.a")" == libspidermonkey_bunwasm.a ]] || exit 1
side="$out/engine.wasm"
[[ ! -e "$side" ]] || { echo "Refusing to overwrite existing experimental side: $side" >&2; exit 1; }
# SPIDERMONKEY_TRANSFER_FAULT=1: a validation side (scripts/src/transfer-fault.sh). Never a
# release: it leaves without the library record a program is staged with.
# shellcheck source=scripts/src/transfer-fault.sh
source "$root/scripts/src/transfer-fault.sh"
select_transfer_fault SPIDERMONKEY_TRANSFER_FAULT
if [[ $transfer_fault == 1 && -e "$out/shared-group-library.json" ]]; then
  echo "Refusing a validation side beside an existing release record: $out/shared-group-library.json" >&2
  exit 2
fi
sysroot_rust=$($RUSTC --print sysroot)
$GUEST_CARGO fetch --locked --offline --manifest-path "$sysroot_rust/lib/rustlib/src/rust/library/Cargo.toml" --target wasm32-wasip1
$GUEST_CARGO build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j "$jobs" -p bunwasm-engine-spidermonkey
archive="$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_spidermonkey.a"
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$sysroot" -fPIC "${features[@]}" -O2 -fno-builtin-malloc -fno-builtin-free \
  -DENGINE_CTOR_VALUE=spidermonkey_ctor_value -c scripts/src/engine-init.c -o "$out/engine-init.o"
"$CC_wasm32_wasip1" --target=wasm32-wasip1 --sysroot="$sysroot" -fPIC "${features[@]}" -O2 \
  -c crates/bunwasm-engine-quickjs/group-errno.c -o "$out/group-errno.o"
# shellcheck source=scripts/src/group-errno-wraps.sh
source "$root/scripts/src/group-errno-wraps.sh"
check_group_errno_wraps "$archive" "$out" "${group_errno_wraps[@]}"
wraps=()
for name in "${group_errno_wraps[@]}"; do wraps+=("--wrap=$name"); done
# The side declares the group address space, like its core (program-profile.ts sharedGroupSideLink).
group_address_space=$(bun scripts/src/program-profile.ts group-address-space)
"$WASI_SDK_PATH/bin/wasm-ld" --shared --shared-memory "--max-memory=$group_address_space" "${wraps[@]}" "${transfer_fault_wraps[@]}" --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --import-table --allow-undefined --export=spidermonkey_ctor_value \
  --export=__stack_pointer --export=__wasm_call_ctors --export=spidermonkey_register --export=spidermonkey_run \
  -Map="$out/engine-link.map" -o "$out/engine.implicit.wasm" "$out/engine-init.o" "$out/group-errno.o" "$archive"
bun scripts/spidermonkey-side-core-receipt.ts convert-side "$out/engine.implicit.wasm" "$side" --group
wasm-tools validate --features all "$side"
if [[ $transfer_fault == 0 ]]; then
  cp "$SPIDERMONKEY_NATIVE_DIR/shared-group-library.json" "$out/shared-group-library.json"
fi
