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
stamp="$LIBCXX_DIR/.bunwasm-inputs"
archives="$LIBCXX_DIR/.bunwasm-archives"
sdk="$WASI_SDK_PATH/bin"
flags="--target=wasm32-wasip1 --sysroot=$BUN_WASM_SYSROOT $JSC_PROFILE_FLAGS"

libcxx_fail() {
  echo "error: libcxx $*; choose a fresh JSC_BUILD_DIR" >&2
  exit 1
}

libcxx_source_tree() (
  [[ "$(git -C "$source_dir" rev-parse HEAD)" == "$llvm_commit" ]] || libcxx_fail "source revision changed"
  local index tree
  index=$(mktemp "$LIBCXX_DIR/.source-index.XXXXXX")
  unlink "$index"
  trap '[[ ! -e "$index" ]] || unlink "$index"' EXIT
  GIT_INDEX_FILE="$index" git -C "$source_dir" read-tree "$llvm_commit"
  GIT_INDEX_FILE="$index" git -C "$source_dir" apply --cached "$LIBCXX_DIR/llvm-pr-186054.patch" "$LIBCXX_DIR/llvm-undo-part-of-194317.patch"
  tree=$(GIT_INDEX_FILE="$index" git -C "$source_dir" write-tree)
  git -C "$source_dir" diff --quiet "$tree" -- || libcxx_fail "patched source changed"
  [[ -z "$(git -C "$source_dir" ls-files --others --exclude-standard)" ]] || libcxx_fail "untracked source inputs"
  printf '%s\n' "$tree"
)

libcxx_inputs_hash() {
  local tree tool path
  tree=$(libcxx_source_tree)
  {
    printf 'libcxx=1\nllvm=%s\nsdk=%s\nsource=%s\nprofile=%s\nflags=%s\ncage=%s\n' "$llvm_commit" "$sdk_commit" "$tree" "$JSC_PROFILE" "$flags" "$CAGE"
    sha256sum "$JSC_SRC/build-libcxx.sh" "$JSC_SRC/common.sh" "$WASI_SDK_PATH/VERSION" "$sdk_config_site" "$BUN_WASM_SYSROOT/bun-wasm-sysroot.json" "$BUN_WASM_SYSROOT/lib/wasm32-wasip1/libc.a" "$LIBCXX_DIR/llvm-pr-186054.patch" "$LIBCXX_DIR/llvm-undo-part-of-194317.patch"
    find -L "$BUN_WASM_SYSROOT/include" "$WASI_SDK_PATH/share/cmake" -type f -print0 | sort -z | xargs -0 -r sha256sum
    for tool in "$sdk/clang" "$sdk/clang++" "$sdk/llvm-ar" "$sdk/llvm-ranlib" cmake ninja; do
      path=$(command -v "$tool") || return 1
      sha256sum "$(readlink -f "$path")"
      "$tool" --version || return 1
    done
  } | sha256sum | cut -d' ' -f1
}

if [[ -e "$stamp" || -e "$archives" || -e "$LIBCXX_DIR/lib/libc++.a" || -e "$LIBCXX_DIR/lib/libc++abi.a" ]]; then
  [[ -s "$stamp" && -s "$archives" && -f "$LIBCXX_DIR/lib/libc++.a" && -f "$LIBCXX_DIR/lib/libc++abi.a" && -f "$LIBCXX_DIR/include/__config_site" ]] || libcxx_fail "cache completion is missing"
  inputs=$(libcxx_inputs_hash)
  [[ "$(cat "$stamp")" == "$inputs" ]] || libcxx_fail "inputs changed"
  current_archives=$(cd "$LIBCXX_DIR" && sha256sum lib/libc++.a lib/libc++abi.a include/__config_site)
  [[ "$(cat "$archives")" == "$current_archives" ]] || libcxx_fail "cached output bytes changed"
  cmp "$sdk_config_site" "$LIBCXX_DIR/include/__config_site" || libcxx_fail "ABI configuration changed"
  echo "libcxx: $LIBCXX_DIR already built and verified"
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
fi
# A matching HEAD is not a completed patch sequence after interruption.
for patch in llvm-pr-186054 llvm-undo-part-of-194317; do
  curl -fsSL -o "$LIBCXX_DIR/$patch.patch" "https://raw.githubusercontent.com/WebAssembly/wasi-sdk/$sdk_commit/src/$patch.patch"
  if git -C "$source_dir" apply --reverse --check "$LIBCXX_DIR/$patch.patch" 2>/dev/null; then
    continue
  fi
  git -C "$source_dir" apply --check "$LIBCXX_DIR/$patch.patch"
  git -C "$source_dir" apply "$LIBCXX_DIR/$patch.patch"
done
inputs=$(libcxx_inputs_hash)
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
[[ "$(libcxx_inputs_hash)" == "$inputs" ]] || libcxx_fail "inputs changed during compilation"
mkdir -p "$LIBCXX_DIR/lib" "$LIBCXX_DIR/include"
cp "$objects/lib/libc++.a" "$objects/lib/libc++abi.a" "$LIBCXX_DIR/lib/"
cp "$built_config_site" "$LIBCXX_DIR/include/__config_site"
(cd "$LIBCXX_DIR" && sha256sum lib/libc++.a lib/libc++abi.a include/__config_site > "$archives.tmp")
printf '%s\n' "$inputs" > "$stamp.tmp"
mv "$archives.tmp" "$archives"
mv "$stamp.tmp" "$stamp"
echo "libcxx: atomics archives in $LIBCXX_DIR/lib"
