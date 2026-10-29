#!/usr/bin/env bash
# Build the Hermes VM for wasm32-wasip1 as one static library, $HERMES_LIB (hermesvm_bunwasm:
# VM, compiler and support code, without the C++ JSI API, plus crates/bunwasm-hermes/cpp/shim.cpp). A host hermesc build comes first: the
# wasm build compiles Hermes's internal JavaScript with it. Incremental. See docs/bun-patches/hermes-wasi.md.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
"$HERMES_SRC/fetch-hermes.sh"

$CAGE cmake -S "$HERMES_DIR" -B "$HERMES_HOST" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=/usr/bin/clang -DCMAKE_CXX_COMPILER=/usr/bin/clang++ \
  -DHERMES_ENABLE_TEST_SUITE=OFF -DHERMES_ENABLE_NAPI=OFF -DHERMES_ENABLE_INTL=OFF \
  -DHERMES_ALLOW_BOOST_CONTEXT=0 > "$HERMES_BUILD_DIR/configure-host.log"
$CAGE cmake --build "$HERMES_HOST" --target hermesc --parallel "$JOBS"

# The mmap define exposes llvh headers only. No mmap emulation library is linked.
# These link flags serve CMake's configure-time checks.
defines="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"
libdir="$BUN_WASM_SYSROOT/lib/wasm32-wasip1"
ldflags="-L$libdir/noeh -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid"
$CAGE cmake -S "$HERMES_DIR" -B "$HERMES_OBJ" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$HERMES_SRC/wasi-hermes.cmake" \
  -DUNIX=1 \
  -DIMPORT_HOST_COMPILERS="$HERMES_HOST/ImportHostCompilers.cmake" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DLLVM_ENABLE_THREADS=OFF \
  -DHAVE_SYS_MMAN_H=1 \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  -DHERMES_ENABLE_NAPI=OFF \
  -DHERMES_ENABLE_INTL=OFF \
  -DHERMES_UNICODE_LITE=ON \
  -DHERMES_SANDBOX_WASM=ON \
  -DHERMES_ALLOW_BOOST_CONTEXT=0 \
  -DHERMESVM_ALLOW_JIT=0 \
  -DHERMESVM_ALLOW_CONCURRENT_GC=OFF \
  -DHERMESVM_ALLOW_CONTIGUOUS_HEAP=OFF \
  -DHERMESVM_ALLOW_INLINE_ASM=OFF \
  -DHERMES_CHECK_NATIVE_STACK=ON \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DHERMESVM_HEAP_HV_MODE=HEAP_HV_PREFER32 \
  -DHERMESVM_LOG_HEAP_SEGMENT_SIZE=20 \
  -DHERMESVM_INDIRECT_THREADING=OFF \
  -DBUNWASM_SHIM="$REPO/crates/bunwasm-hermes/cpp/shim.cpp" \
  -DCMAKE_C_FLAGS="$defines -fPIC" \
  -DCMAKE_CXX_FLAGS="$defines -fPIC -fno-exceptions -fno-rtti" \
  -DCMAKE_EXE_LINKER_FLAGS="$ldflags" > "$HERMES_BUILD_DIR/configure-wasi.log"
build_hermes_lib
node "$HERMES_SRC/check-build.ts" "$HERMES_BUILD_DIR"
