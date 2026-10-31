#!/usr/bin/env bash
# Configure and build the pinned SpiderMonkey WASI static library.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ "$("$CARGO_HOME/bin/cbindgen" --version)" == "cbindgen 0.29.4" ]] || {
  echo "spidermonkey: install cbindgen 0.29.4 with cargo install --locked --version 0.29.4 cbindgen" >&2
  exit 1
}
"$SPIDERMONKEY_SRC/fetch-spidermonkey.sh"

mozconfig="$SPIDERMONKEY_BUILD_DIR/mozconfig"
sed "s#@TOPSRCDIR@#$SPIDERMONKEY_DIR#g" "$SPIDERMONKEY_SRC/mozconfig.in" > "$mozconfig"
export MOZCONFIG="$mozconfig"
export MOZBUILD_STATE_PATH="$SPIDERMONKEY_BUILD_DIR/mozbuild"
export MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=system
export MACH_NO_TELEMETRY=1
export TMPDIR="$SPIDERMONKEY_BUILD_DIR/tmp"
mkdir -p "$TMPDIR"

if [[ ! -f "$SPIDERMONKEY_OBJDIR/config.status" ]]; then
  $CAGE "$SPIDERMONKEY_DIR/mach" --no-interactive configure 2>&1 \
    | tee "$SPIDERMONKEY_BUILD_DIR/configure.log"
fi
$CAGE "$SPIDERMONKEY_DIR/mach" --no-interactive build -j "$JOBS" 2>&1 \
  | tee "$SPIDERMONKEY_BUILD_DIR/build.log"

cp "$SPIDERMONKEY_OBJDIR/clangd/compile_commands.json" "$SPIDERMONKEY_BUILD_DIR/compile_commands.json"
node "$SPIDERMONKEY_SRC/check-build.ts" "$SPIDERMONKEY_BUILD_DIR"
