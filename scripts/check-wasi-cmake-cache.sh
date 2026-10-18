#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
source "$root/env.sh"
if [[ $# != 2 && ( $# != 3 || "$3" != --require-configured ) ]]; then
  echo 'usage: check-wasi-cmake-cache.sh BUILD_DIRECTORY TOOLCHAIN_FILE [--require-configured]' >&2
  exit 2
fi
cmake -DBUILD_DIR="$1" -DREQUIRE_CONFIGURED="${3:+ON}" \
  -DEXPECTED_C="$WASI_SDK_PATH/bin/clang" -DEXPECTED_CXX="$WASI_SDK_PATH/bin/clang++" \
  -DEXPECTED_SYSTEM=WASI -DEXPECTED_PROCESSOR=wasm32 -DEXPECTED_TARGET=wasm32-wasip1 \
  -DEXPECTED_SYSROOT="$BUN_WASM_SYSROOT" -DEXPECTED_TOOLCHAIN_FILE="$2" \
  -P "$root/scripts/check-cmake-cache.cmake"
