#!/usr/bin/env bash
# Post-link step every wasm binary containing JSC needs: spill pointer-sized wasm locals to the
# C stack so JSC's conservative stack scan sees them. Without it the GC frees live cells (wasm
# locals live outside linear memory). Then optimize and strip DWARF, keeping the name section
# (function names in wasm stack traces; about +3% gzipped).
# Usage: jsc/finalize.sh in.wasm out.wasm
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
[[ $# -eq 2 ]] || { echo "usage: finalize.sh in.wasm out.wasm" >&2; exit 2; }
$CAGE "$WASM_OPT" --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int \
  --enable-sign-ext --enable-mutable-globals --enable-multivalue --enable-reference-types \
  --spill-pointers -O2 -g --strip-dwarf --strip-producers "$1" -o "$2"
