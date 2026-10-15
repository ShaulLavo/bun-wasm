# Sourced by the jsc/*.sh scripts: paths and the memory cage.
set -euo pipefail
JSC_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$JSC_SRC/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO/env.sh"
JSC_BUILD_DIR="${JSC_BUILD_DIR:-/work/tmp/bun-wasm-jsc}"
WEBKIT_DIR="$JSC_BUILD_DIR/webkit"
ICU_DIR="$JSC_BUILD_DIR/icu"
ICU_PREFIX="$ICU_DIR/prefix"
JSC_OBJ="$JSC_BUILD_DIR/build/jsc"
SHIM_DIR="$JSC_BUILD_DIR/shim"
JOBS="${JOBS:-6}"
# The commit Bun pins (oven-sh/bun scripts/build/deps/webkit.ts) and its ICU (icu/source.json there).
WEBKIT_COMMIT=3d3257150c40a1aabdc5f8b48d5b33d0413674cb
ICU_VERSION=78.3
ICU_SHA256=3a2e7a47604ba702f345878308e6fefeca612ee895cf4a5f222e7955fabfe0c0
# Every compile step runs in a memory cage: this machine also runs production services.
# CAGE= disables it (e.g. on a build box).
CAGE="${CAGE-systemd-run --user --scope -q -p MemoryMax=5G -p CPUWeight=20 nice -n 10}"
# clang runs wasm-opt after any optimized link when it finds it in PATH: that strips the name
# section and takes minutes on JSC. Links here run without it; finalize.sh runs it explicitly.
WASM_OPT="$(command -v wasm-opt)"
PATH_NO_BINARYEN="$(echo "$PATH" | tr ':' '\n' | grep -v binaryen | paste -sd:)"
mkdir -p "$JSC_BUILD_DIR"

# The shim: wasi-compat.o (temp files) and madvise.o, separate members so a link that already
# defines madvise (bunwasm-posix) doesn't pull a duplicate. configure.sh needs it to exist
# (every CMake link test links it), build.sh refreshes it.
build_shim() {
  mkdir -p "$SHIM_DIR"
  local c
  for c in wasi-compat madvise; do
    "$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 -O2 -c "$JSC_SRC/shim/$c.c" -o "$SHIM_DIR/$c.o"
  done
  rm -f "$SHIM_DIR/libwasi-compat.a"
  "$WASI_SDK_PATH/bin/llvm-ar" rcs "$SHIM_DIR/libwasi-compat.a" "$SHIM_DIR/wasi-compat.o" "$SHIM_DIR/madvise.o"
}
