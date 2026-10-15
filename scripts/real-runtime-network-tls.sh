#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
if [[ $# != 2 ]]; then
  echo 'usage: scripts/real-runtime-network-tls.sh BORINGSSL_SOURCE BUILD_DIRECTORY' >&2
  echo 'source pin: oven-sh/boringssl 41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f' >&2
  exit 2
fi
source_dir=$(realpath "$1")
build_dir=$(realpath -m "$2")
cage=(systemd-run --user --scope -p MemoryMax=4G nice -n 10)
"${cage[@]}" cmake -S "$source_dir" -B "$build_dir" -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$root/jsc/wasi-jsc.cmake" \
  -DCMAKE_BUILD_TYPE=Release -DOPENSSL_NO_ASM=1 -DBUILD_TESTING=OFF \
  -DCMAKE_C_FLAGS="-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK" \
  -DCMAKE_CXX_FLAGS="-DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -DOPENSSL_NO_SOCK"
"${cage[@]}" ninja -C "$build_dir" -k 0 -j 6 crypto ssl
smoke=$(mktemp "$build_dir/realrt-smoke-XXXXXX.wasm")
trap 'rm -f "$smoke"' EXIT
PATH=/usr/bin:/bin "${cage[@]}" "$WASI_SDK_PATH/bin/clang++" \
  --target=wasm32-wasip1 -O2 -fno-exceptions -fno-rtti \
  -I"$source_dir/include" "$root/jsc/real-runtime-tls-smoke.cpp" \
  "$build_dir/libssl.a" "$build_dir/libcrypto.a" -o "$smoke"
"${cage[@]}" wasmtime run "$smoke"
