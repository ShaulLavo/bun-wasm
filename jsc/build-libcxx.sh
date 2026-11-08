#!/usr/bin/env bash
# libc++ and libc++abi for a shared-group JSC side: wasi-sdk 34's exact LLVM source, patches and
# configuration, plus PIC and real wasm atomics. The SDK's own archives are not built with atomics
# and wasm-ld refuses them under --shared-memory. Output: $JSC_BUILD_DIR/libcxx/lib/libc++{,abi}.a
# Provenance: docs/bun-patches/jsc-shared-group.md.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ "$JSC_PROFILE" == shared-group ]] || { echo "error: build-libcxx.sh is shared-group only" >&2; exit 2; }
llvm_commit=895aa2c896ada719451be2e3673c83da8ddf1141
sdk_commit=5a0bf653a1a06e1c18867567c5937006d3394a69
source_dir="$LIBCXX_DIR/llvm-project"
objects="$LIBCXX_DIR/build"
sdk_config_site="$WASI_SDK_PATH/share/wasi-sysroot/include/wasm32-wasip1/noeh/c++/v1/__config_site"
if [[ -f "$LIBCXX_DIR/lib/libc++.a" && -f "$LIBCXX_DIR/lib/libc++abi.a" ]]; then
  echo "libcxx: $LIBCXX_DIR already built"
  exit 0
fi
mkdir -p "$LIBCXX_DIR"
if [[ ! -e "$source_dir/.git" ]]; then
  git init -q "$source_dir"
  git -C "$source_dir" remote add origin https://github.com/llvm/llvm-project.git
  git -C "$source_dir" config remote.origin.promisor true
  git -C "$source_dir" config remote.origin.partialclonefilter blob:none
  git -C "$source_dir" sparse-checkout set runtimes cmake libcxx libcxxabi libc llvm/cmake llvm/utils/llvm-lit third-party
fi
if [[ "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null)" != "$llvm_commit" ]]; then
  git -C "$source_dir" fetch -q --depth 1 --filter=blob:none origin "$llvm_commit"
  git -C "$source_dir" checkout -q --detach "$llvm_commit"
  for patch in llvm-pr-186054 llvm-undo-part-of-194317; do
    curl -fsSL -o "$LIBCXX_DIR/$patch.patch" "https://raw.githubusercontent.com/WebAssembly/wasi-sdk/$sdk_commit/src/$patch.patch"
    git -C "$source_dir" apply "$LIBCXX_DIR/$patch.patch"
  done
fi
sdk="$WASI_SDK_PATH/bin"
flags="--target=wasm32-wasip1 --sysroot=$BUN_WASM_SYSROOT $JSC_PROFILE_FLAGS"
$CAGE cmake -G Ninja -S "$source_dir/runtimes" -B "$objects" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_SYSTEM_NAME=WASI \
  -DCMAKE_SYSTEM_VERSION=1 \
  -DCMAKE_SYSTEM_PROCESSOR=wasm32 \
  -DCMAKE_MODULE_PATH="$WASI_SDK_PATH/share/cmake" \
  -DCMAKE_C_COMPILER="$sdk/clang" \
  -DCMAKE_CXX_COMPILER="$sdk/clang++" \
  -DCMAKE_ASM_COMPILER="$sdk/clang" \
  -DCMAKE_AR="$sdk/llvm-ar" \
  -DCMAKE_RANLIB="$sdk/llvm-ranlib" \
  -DCMAKE_C_COMPILER_WORKS=ON \
  -DCMAKE_CXX_COMPILER_WORKS=ON \
  -DCMAKE_SYSROOT="$BUN_WASM_SYSROOT" \
  -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DCMAKE_C_FLAGS="$flags" \
  -DCMAKE_ASM_FLAGS="$flags" \
  -DCMAKE_CXX_FLAGS="$flags" \
  -DUNIX:BOOL=ON \
  -DLLVM_COMPILER_CHECKED=ON \
  -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
  -DLIBCXX_ENABLE_THREADS:BOOL=ON \
  -DLIBCXX_HAS_PTHREAD_API:BOOL=ON \
  -DLIBCXX_HAS_EXTERNAL_THREAD_API:BOOL=OFF \
  -DLIBCXX_HAS_WIN32_THREAD_API:BOOL=OFF \
  -DLIBCXX_ENABLE_SHARED:BOOL=OFF \
  -DLIBCXX_ENABLE_EXCEPTIONS:BOOL=OFF \
  -DLIBCXX_ENABLE_FILESYSTEM:BOOL=ON \
  -DLIBCXX_ENABLE_ABI_LINKER_SCRIPT:BOOL=OFF \
  -DLIBCXX_CXX_ABI=libcxxabi \
  -DLIBCXX_HAS_MUSL_LIBC:BOOL=OFF \
  -DLIBCXX_ABI_VERSION=2 \
  -DLIBCXXABI_ENABLE_EXCEPTIONS:BOOL=OFF \
  -DLIBCXXABI_ENABLE_SHARED:BOOL=OFF \
  -DLIBCXXABI_SILENT_TERMINATE:BOOL=ON \
  -DLIBCXXABI_ENABLE_THREADS:BOOL=ON \
  -DLIBCXXABI_HAS_PTHREAD_API:BOOL=ON \
  -DLIBCXXABI_HAS_EXTERNAL_THREAD_API:BOOL=OFF \
  -DLIBCXXABI_HAS_WIN32_THREAD_API:BOOL=OFF \
  -DLIBCXXABI_USE_LLVM_UNWINDER:BOOL=OFF \
  -DLIBCXX_INCLUDE_TESTS=OFF \
  -DLIBCXX_INCLUDE_BENCHMARKS=OFF > "$LIBCXX_DIR/configure.log"
$CAGE ninja -C "$objects" -j"$JOBS" cxx_static cxxabi_static > "$LIBCXX_DIR/build.log"
# JSC, ICU and the side compile against the SDK's headers, so its ABI configuration must match exactly.
built_config_site="$objects/libcxx/include/c++/v1/__config_site"
[[ -f "$built_config_site" ]] || built_config_site=$(find "$objects" -name __config_site -print -quit)
cmp "$sdk_config_site" "$built_config_site"
mkdir -p "$LIBCXX_DIR/lib"
cp "$objects/lib/libc++.a" "$objects/lib/libc++abi.a" "$LIBCXX_DIR/lib/"
echo "libcxx: atomics archives in $LIBCXX_DIR/lib"
