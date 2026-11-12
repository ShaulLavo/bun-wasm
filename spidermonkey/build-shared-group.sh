#!/usr/bin/env bash
# Build the pinned SpiderMonkey library for a shared-group side: the split recipe's source, patch
# and configuration, plus real wasm atomics, the shared-pic sysroot and
# spidermonkey-shared-group.patch. The split recipe files and the admitted split archive are not
# changed. Output: $SPIDERMONKEY_BUILD_DIR/native. Provenance:
# docs/bun-patches/spidermonkey-shared-group.md.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
if [[ -z "${BUN_WASM_SHARED_SYSROOT:-}" || "$BUN_WASM_SYSROOT" != "$BUN_WASM_SHARED_SYSROOT" ]]; then
  echo "spidermonkey: a shared-group build needs BUN_WASM_SYSROOT and BUN_WASM_SHARED_SYSROOT set to the same shared-pic sysroot" >&2
  exit 1
fi
[[ "$("$CARGO_HOME/bin/cbindgen" --version)" == "cbindgen 0.29.4" ]] || {
  echo "spidermonkey: install cbindgen 0.29.4 with cargo install --locked --version 0.29.4 cbindgen" >&2
  exit 1
}
[[ "$JOBS" =~ ^[1-4]$ ]] || { echo "spidermonkey: the library build allows 1 to 4 jobs" >&2; exit 1; }
export CARGO_BUILD_JOBS="$JOBS"
"$SPIDERMONKEY_SRC/fetch-spidermonkey.sh"
# shellcheck source=spidermonkey/patch-lifecycle.sh
source "$SPIDERMONKEY_SRC/patch-lifecycle.sh"
spidermonkey_patch_prepare "$SPIDERMONKEY_DIR" "$SPIDERMONKEY_SRC/spidermonkey-shared-group.patch" > /dev/null

group_flags="-matomics -mbulk-memory -mmutable-globals -DBUN_WASM_SHARED_GROUP=1"
mozconfig="$SPIDERMONKEY_BUILD_DIR/mozconfig"
{
  sed "s#@TOPSRCDIR@#$SPIDERMONKEY_DIR#g" "$SPIDERMONKEY_SRC/mozconfig.in"
  # shellcheck disable=SC2016 # mach expands the earlier values when it reads the file.
  printf 'export CFLAGS="$CFLAGS %s"\nexport CXXFLAGS="$CXXFLAGS %s"\n' "$group_flags" "$group_flags"
} > "$mozconfig"
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

node "$SPIDERMONKEY_SRC/shared-group.ts" "$SPIDERMONKEY_BUILD_DIR"
