#!/usr/bin/env bash
# CMake configure of JavaScriptCore for wasm32-wasip1: JSCOnly port, C loop interpreter (no JIT,
# no WebAssembly), system malloc, static libraries, Bun's JSC additions on.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
mkdir -p "$JSC_OBJ"
bash "$REPO/scripts/check-wasi-cmake-cache.sh" "$JSC_OBJ" "$JSC_TOOLCHAIN_FILE"
build_shim
flags="-include $JSC_CONFIG_SHIM_DIR/wasi-compat.h -msimd128 -DSIMDE_FLOAT16_API=1 \
-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
# The jsc shell's link. 512 MiB: the cap bun-wasm links with (Bun's string pointer tags).
ldflags="-lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid \
-Wl,-z,stack-size=8388608 -Wl,--max-memory=536870912"
cd "$JSC_OBJ"
$CAGE cmake -G Ninja "$WEBKIT_DIR" \
  -DCMAKE_TOOLCHAIN_FILE="$JSC_TOOLCHAIN_FILE" \
  -DPORT=JSCOnly \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE="-O2 -DNDEBUG=1" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O2 -DNDEBUG=1" \
  -DENABLE_STATIC_JSC=ON \
  -DUSE_THIN_ARCHIVES=OFF \
  -DUSE_BUN_JSC_ADDITIONS=ON \
  -DENABLE_BUN_SKIP_FAILING_ASSERTIONS=ON \
  -DENABLE_C_LOOP=ON \
  -DENABLE_JIT=OFF -DENABLE_DFG_JIT=OFF -DENABLE_FTL_JIT=OFF \
  -DENABLE_WEBASSEMBLY=OFF \
  -DENABLE_SAMPLING_PROFILER=OFF \
  -DENABLE_REMOTE_INSPECTOR=OFF \
  -DENABLE_RESOURCE_USAGE=OFF \
  -DENABLE_API_TESTS=OFF \
  -DDEVELOPER_MODE=OFF \
  -DUSE_SYSTEM_MALLOC=ON \
  -DUSE_MIMALLOC=OFF \
  -DENABLE_ASSERTS=OFF \
  -DICU_ROOT="$ICU_PREFIX" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DCMAKE_C_FLAGS="$flags" \
  -DCMAKE_CXX_FLAGS="$flags -fno-exceptions" \
  -DCMAKE_CXX_STANDARD_LIBRARIES="$SHIM_DIR/libwasi-compat.a" \
  -DCMAKE_EXE_LINKER_FLAGS="$ldflags" \
  "$@" > "$JSC_BUILD_DIR/configure.log"
echo "configure: $JSC_OBJ"
