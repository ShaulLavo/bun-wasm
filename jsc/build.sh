#!/usr/bin/env bash
# Build the wasi-compat shim (common.sh), then ninja targets in the JSC tree (default: the libraries and the
# jsc shell). Usage: jsc/build.sh [ninja targets...]
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

bash "$REPO/scripts/check-wasi-cmake-cache.sh" "$JSC_OBJ" "$JSC_TOOLCHAIN_FILE" --require-configured
build_shim

# The derived-sources generators need ERB; Arch's ruby ships it as a separate gem.
if ! ruby -e 'require "erb"' 2>/dev/null; then
  export GEM_PATH="$JSC_BUILD_DIR/gems"
  ruby -e 'require "erb"' 2>/dev/null || gem install erb --no-document --install-dir "$GEM_PATH" >/dev/null
fi

targets=("$@")
[[ ${#targets[@]} -gt 0 ]] || targets=(JavaScriptCore WTF bmalloc jsc)
PATH="$PATH_NO_BINARYEN" $CAGE ninja -C "$JSC_OBJ" -j"$JOBS" "${targets[@]}"
