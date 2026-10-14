#!/usr/bin/env bash
# Build the wasi-compat shim, then ninja targets in the JSC tree (default: the libraries and the
# jsc shell). Usage: jsc/build.sh [ninja targets...]
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Shim: wasi-compat.o (temp files) and madvise.o, separate members so a link that already
# defines madvise (bunwasm-posix) doesn't pull a duplicate.
mkdir -p "$SHIM_DIR"
for c in wasi-compat madvise; do
  "$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 -O2 -c "$JSC_SRC/shim/$c.c" -o "$SHIM_DIR/$c.o"
done
rm -f "$SHIM_DIR/libwasi-compat.a"
"$WASI_SDK_PATH/bin/llvm-ar" rcs "$SHIM_DIR/libwasi-compat.a" "$SHIM_DIR/wasi-compat.o" "$SHIM_DIR/madvise.o"

# The derived-sources generators need ERB; Arch's ruby ships it as a separate gem.
if ! ruby -e 'require "erb"' 2>/dev/null; then
  export GEM_PATH="$JSC_BUILD_DIR/gems"
  ruby -e 'require "erb"' 2>/dev/null || gem install erb --no-document --install-dir "$GEM_PATH" >/dev/null
fi

targets=("$@")
[[ ${#targets[@]} -gt 0 ]] || targets=(JavaScriptCore WTF bmalloc jsc)
PATH="$PATH_NO_BINARYEN" $CAGE ninja -C "$JSC_OBJ" -j"$JOBS" "${targets[@]}"
