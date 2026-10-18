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
JSC_CONFIG_DIR="$JSC_BUILD_DIR/inputs"
JSC_CONFIG_SHIM_DIR="$JSC_CONFIG_DIR/shim"
JSC_TOOLCHAIN_FILE="$JSC_CONFIG_DIR/wasi-jsc.cmake"
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

JSC_INPUTS_STAMP="$JSC_BUILD_DIR/build/jsc/.bunwasm-inputs"

jsc_inputs_hash() {
  {
    printf 'format=2\n'
    printf 'WEBKIT_COMMIT=%s\n' "$WEBKIT_COMMIT"
    printf 'ICU_VERSION=%s\n' "$ICU_VERSION"
    printf 'ICU_SHA256=%s\n' "$ICU_SHA256"
    # Fingerprint the effective build environment, not unrelated workstation
    # scratch/cache policy or comments in the shell file that establishes it.
    for variable in WASI_SDK_PATH BUN_WASM_SYSROOT CC CXX AR RANLIB CFLAGS CXXFLAGS CPPFLAGS LDFLAGS \
      CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH; do
      printf '%s=%s\n' "$variable" "${!variable-}"
    done
    printf 'scripts/build-jsc.sh='
    sha256sum "$REPO/scripts/build-jsc.sh" | cut -d' ' -f1
    for file in wasi-jsc.cmake shim/wasi-compat.h shim/wasi-compat.c shim/madvise.c; do
      printf 'embedded/%s=' "$file"
      if [[ -f "$JSC_CONFIG_DIR/$file" ]]; then
        sha256sum "$JSC_CONFIG_DIR/$file" | cut -d' ' -f1
      else
        printf 'missing\n'
      fi
    done
    (
      cd "$JSC_SRC"
      find . -type f \
        ! -name README.md \
        ! -name real-runtime-probe.py \
        ! -name real-runtime-tls-smoke.cpp \
        -print0 | sort -z | while IFS= read -r -d '' file; do
        sha256sum "$file"
      done
    )
    printf 'patched-sysroot/receipt\n'
    cat "$BUN_WASM_SYSROOT/bun-wasm-sysroot.json"
    printf 'wasi-sdk/VERSION\n'
    cat "$WASI_SDK_PATH/VERSION"
    printf 'clang: '
    "$WASI_SDK_PATH/bin/clang" --version | head -1
    printf 'cmake: '
    cmake --version | head -1
    printf 'ninja: '
    ninja --version
    printf 'wasm-opt: '
    wasm-opt --version | head -1
  } | sha256sum | cut -d' ' -f1
}

copy_jsc_config_inputs() {
  mkdir -p "$JSC_CONFIG_SHIM_DIR"
  # Preserve identical input timestamps: the injected header is a dependency of
  # every WebKit object, so touching it makes a no-op refresh rebuild the engine.
  if ! cmp -s "$JSC_SRC/wasi-jsc.cmake" "$JSC_TOOLCHAIN_FILE"; then
    cp "$JSC_SRC/wasi-jsc.cmake" "$JSC_TOOLCHAIN_FILE"
  fi
  for file in wasi-compat.h wasi-compat.c madvise.c; do
    if ! cmp -s "$JSC_SRC/shim/$file" "$JSC_CONFIG_SHIM_DIR/$file"; then
      cp "$JSC_SRC/shim/$file" "$JSC_CONFIG_SHIM_DIR/$file"
    fi
  done
}

write_jsc_inputs_stamp() {
  mkdir -p "$(dirname "$JSC_INPUTS_STAMP")"
  jsc_inputs_hash > "$JSC_INPUTS_STAMP"
}

check_jsc_inputs_stamp() {
  local expected actual
  expected="$(jsc_inputs_hash)"
  actual="$(cat "$JSC_INPUTS_STAMP" 2>/dev/null || true)"
  if [[ "$actual" != "$expected" ]]; then
    echo "error: the JSC prebuild at $JSC_BUILD_DIR was built from different JSC inputs; rebuild with JSC_BUILD_DIR=$JSC_BUILD_DIR scripts/build-jsc.sh (or point JSC_BUILD_DIR at a fresh directory)." >&2
    return 1
  fi
}

# The shim: wasi-compat.o (temp files) and madvise.o, separate members so a link that already
# defines madvise (bunwasm-posix) doesn't pull a duplicate. configure.sh needs it to exist
# (every CMake link test links it), build.sh refreshes it.
build_shim() {
  mkdir -p "$SHIM_DIR"
  copy_jsc_config_inputs
  local c
  for c in wasi-compat madvise; do
    "$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -O2 -c "$JSC_CONFIG_SHIM_DIR/$c.c" -o "$SHIM_DIR/$c.o"
  done
  rm -f "$SHIM_DIR/libwasi-compat.a"
  "$WASI_SDK_PATH/bin/llvm-ar" rcs "$SHIM_DIR/libwasi-compat.a" "$SHIM_DIR/wasi-compat.o" "$SHIM_DIR/madvise.o"
}
