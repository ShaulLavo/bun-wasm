#!/usr/bin/env bash
# Actual rquickjs shared module. The registered RUN entry owns the VM and application driver.
# Contract and provenance: docs/bun-patches/quickjs-shared-module.md.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source env.sh
out=${QUICKJS_BUILD_DIR:?Set QUICKJS_BUILD_DIR to a lane-private build directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/target"
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS='-C relocation-model=pic -C panic=abort -C link-self-contained=no'
export CFLAGS_wasm32_wasip1="--sysroot=$BUN_WASM_SYSROOT -fPIC"
export RQUICKJS_SYS_NO_WASI_SDK=1
cargo build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 \
  -j "${CARGO_BUILD_JOBS:-4}" -p bunwasm-engine-quickjs
clang --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -fPIC -O2 -fno-builtin-malloc -fno-builtin-free -c \
  tests/linker/quickjs/engine-init.c -o "$out/engine-init.o"
exports=(quickjs_ctor_value __stack_pointer __wasm_call_ctors)
if [[ "${QUICKJS_SMOKE_EXPORTS:-0}" == 1 ]]; then
  exports+=(quickjs_helpers_smoke quickjs_link_smoke quickjs_rust_alloc quickjs_rust_free quickjs_rust_realloc
    quickjs_stack_reenter quickjs_interrupt_smoke quickjs_stack_guard_smoke)
else
  exports+=(quickjs_register quickjs_run)
fi
args=()
for name in "${exports[@]}"; do args+=("--export=$name"); done
wasm-ld --shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry \
  --import-memory=env,memory --export-memory --import-table --allow-undefined "${args[@]}" \
  -o "$out/engine.implicit.wasm" "$out/engine-init.o" "$CARGO_TARGET_DIR/wasm32-wasip1/release/libbunwasm_engine_quickjs.a"
node tests/linker/quickjs/explicit-init.ts "$out/engine.implicit.wasm" "$out/engine.wasm"
wasm-tools validate "$out/engine.wasm"
