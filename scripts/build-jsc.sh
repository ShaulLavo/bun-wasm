#!/usr/bin/env bash
# Build JavaScriptCore (Bun's WebKit fork) for wasm32-wasip1: WebKit checkout, ICU, configure,
# build, finalize. Outputs go to ${JSC_BUILD_DIR:-/work/tmp/bun-wasm-jsc}, never the repo:
#   build/jsc/lib/lib{JavaScriptCore,WTF,bmalloc}.a  icu/prefix/lib/libicu*.a  shim/libwasi-compat.a
#   jsc.wasm (the jsc shell, finalized)
# See docs/jsc-build.md.
set -euo pipefail
jsc="$(cd "$(dirname "${BASH_SOURCE[0]}")/../jsc" && pwd)"
source "$jsc/common.sh"
bun "$REPO/scripts/build-wasi-sysroot.ts"
"$jsc/fetch-webkit.sh"
"$jsc/build-icu.sh"
rm -f "$JSC_INPUTS_STAMP"
"$jsc/configure.sh"
"$jsc/build.sh"
"$jsc/finalize.sh" "$JSC_OBJ/bin/jsc" "$JSC_BUILD_DIR/jsc.wasm"
write_jsc_inputs_stamp
ls -l "$JSC_BUILD_DIR/jsc.wasm"
echo "jsc: inputs stamp $JSC_INPUTS_STAMP ($(cat "$JSC_INPUTS_STAMP"))"
