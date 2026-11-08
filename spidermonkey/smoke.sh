#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
report=${SPIDERMONKEY_G2_REPORT_DIR:?set a retained report directory}
export SPIDERMONKEY_BUILD_DIR=${SPIDERMONKEY_BUILD_DIR:?set the admitted G1 root}
export SPIDERMONKEY_G2_DIR=${SPIDERMONKEY_G2_DIR:?set a distinct successor directory}
[[ "$SPIDERMONKEY_G2_DIR" != "$SPIDERMONKEY_BUILD_DIR" ]] || exit 2
export CARGO_TARGET_DIR="$SPIDERMONKEY_G2_DIR/target"
source "$repo/env.sh"
source "$repo/spidermonkey/patch-lifecycle.sh"
patch_state=untouched
cleanup() {
  status=$?
  spidermonkey_patch_restore "$patch_state" "$SPIDERMONKEY_BUILD_DIR/firefox" "$repo/spidermonkey/spidermonkey-wasi.patch"
  {
    echo "exit=$status"; date --iso-8601=seconds
    git -C "$SPIDERMONKEY_BUILD_DIR/firefox" status --short
    sha256sum "$SPIDERMONKEY_BUILD_DIR/libspidermonkey_bunwasm.a" "$SPIDERMONKEY_BUILD_DIR/receipt/vm-library.json"
    if [[ -d "$SPIDERMONKEY_G2_DIR" ]]; then du -sb "$SPIDERMONKEY_G2_DIR"; fi
  } > "$report/cleanup.txt"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$SPIDERMONKEY_G2_DIR" "$report"
exec 9>"$SPIDERMONKEY_BUILD_DIR.g2-lock"
flock -n 9
ps -eo pid,ppid,args > "$report/processes-before.txt"
df -B1 "$SPIDERMONKEY_G2_DIR" > "$report/storage-before.txt"
patch_state=$(spidermonkey_patch_prepare "$SPIDERMONKEY_BUILD_DIR/firefox" "$repo/spidermonkey/spidermonkey-wasi.patch")
cd "$repo"
node spidermonkey/rebuild-g2.ts "$SPIDERMONKEY_BUILD_DIR" "$SPIDERMONKEY_G2_DIR"
export CXXFLAGS_wasm32_wasip1="--sysroot=$BUN_WASM_SYSROOT -fPIC -fno-exceptions"
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C relocation-model=pic -C panic=abort -C link-self-contained=no -L native=$BUN_WASM_SYSROOT/lib/wasm32-wasip1"
cargo build -Zbuild-std=std,panic_abort --locked --release -j 6 --target wasm32-wasip1 -p bunwasm-spidermonkey --features standalone --example smoke --example side
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/examples/smoke.wasm" "$SPIDERMONKEY_G2_DIR/smoke.wasm"
smoke="$SPIDERMONKEY_G2_DIR/smoke.wasm"
wasm-tools validate "$smoke"
for tier in interp pbl; do
  timeout 60s wasmtime run -W max-wasm-stack=16777216 "$smoke" "$tier" 2>&1 | tee "$report/$tier.log"
done

timeout 60s node "$repo/spidermonkey/check-oom.ts" "$smoke" 2>&1 | tee "$report/oom.log"
"$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC -O2 -DENGINE_CTOR_VALUE=spidermonkey_ctor_value -c scripts/src/engine-init.c -o "$SPIDERMONKEY_G2_DIR/engine-init.o"
"$WASI_SDK_PATH/bin/wasm-ld" --shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
 --import-memory=env,memory --import-table --allow-undefined \
 --export=spidermonkey_ctor_value --export=__stack_pointer --export=__wasm_call_ctors \
 --export=spidermonkey_register --export=spidermonkey_run \
 -Map="$SPIDERMONKEY_G2_DIR/side.map" -o "$SPIDERMONKEY_G2_DIR/side.implicit.wasm" \
 "$SPIDERMONKEY_G2_DIR/engine-init.o" "$CARGO_TARGET_DIR/wasm32-wasip1/release/examples/libside.a"
bun scripts/src/engine-explicit-init.ts spidermonkey "$SPIDERMONKEY_G2_DIR/side.implicit.wasm" "$SPIDERMONKEY_G2_DIR/spidermonkey-engine.wasm"
wasm-tools validate "$SPIDERMONKEY_G2_DIR/spidermonkey-engine.wasm"
bun scripts/side-import-delta.ts "$SPIDERMONKEY_G2_DIR/spidermonkey-engine.wasm" > "$report/import-delta.txt"

node spidermonkey/build-probe-core.ts "$SPIDERMONKEY_G2_DIR/spidermonkey-engine.wasm" "$SPIDERMONKEY_G2_DIR/core.wasm"
export SPIDERMONKEY_G2_CORE="$SPIDERMONKEY_G2_DIR/core.wasm"
BUN_WASM_HOST_STACK_KIB=16384 CARGO_TARGET_DIR="${SPIDERMONKEY_HOST_TARGET_DIR:-$SPIDERMONKEY_G2_DIR/host-target}" cargo test --locked --release -j 6 -p bunwasm-host spidermonkey_g2::real_side_loading -- --ignored --nocapture 2>&1 | tee "$report/linked.log"

node spidermonkey/check-smoke.ts "$SPIDERMONKEY_G2_DIR" "$report"
