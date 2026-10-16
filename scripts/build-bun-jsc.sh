#!/usr/bin/env bash
# Build dist/bun-jsc.wasm: bunwasm-cli with the JavaScriptCore engine (feature engine-jsc,
# crates/bunwasm-runtime/src/engine_jsc.rs) linked with the static JavaScriptCore from
# scripts/build-jsc.sh, then finalized (wasm-opt --spill-pointers, which JSC's GC needs; see
# jsc/README.md). Same runtime and polyfills as dist/bun.wasm.
#
# Its own target dir: `-C link-self-contained=no` (one wasi-libc, wasi-sdk's, for Rust, JSC and
# libc++) changes RUSTFLAGS, which would invalidate the shared target dir's cache.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/jsc/common.sh"
export CARGO_TARGET_DIR="${JSC_CARGO_TARGET_DIR:-$JSC_BUILD_DIR/target}"
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="--cap-lints=warn -C link-self-contained=no"
export JSC_BUILD_DIR
# rquickjs-sys isn't built here, but sqlite's cc build uses the same wasi-sdk.
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"
[[ -f "$JSC_OBJ/lib/libJavaScriptCore.a" ]] || "$root/scripts/build-jsc.sh"
# jsc/webkit-wasi.patch gives WTF's StackBounds a native recursion budget (docs/stack-limits.md).
# A WTF built before that links fine, but lets getters and Proxy traps exhaust the host's wasm stack.
if ! LC_ALL=C grep -qa BUN_WASM_STACK_KIB "$JSC_OBJ/lib/libWTF.a"; then
  echo "error: $JSC_OBJ/lib/libWTF.a was built without the StackBounds budget in jsc/webkit-wasi.patch." >&2
  echo "Reset $WEBKIT_DIR (git -C $WEBKIT_DIR checkout -- .) and rerun scripts/build-jsc.sh." >&2
  exit 1
fi

PATH="$PATH_NO_BINARYEN" $CAGE cargo build -j "$JOBS" --release --target wasm32-wasip1 -p bunwasm-cli \
  --no-default-features --features engine-jsc,bun-transpiler,bun-build
raw="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
mkdir -p "$root/dist"
"$root/jsc/finalize.sh" "$raw" "$root/dist/bun-jsc.wasm"
printf 'dist/bun-jsc.wasm: %s bytes (cargo output: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun-jsc.wasm")" "$(stat -c %s "$raw")"
