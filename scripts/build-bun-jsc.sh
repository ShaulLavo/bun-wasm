#!/usr/bin/env bash
# Compose the verified common core with one finalized JSC program side.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/jsc/common.sh"
cd "$root"
bun "$root/scripts/build-wasi-sysroot.ts"
check_jsc_inputs_stamp
"$root/scripts/sync-crypto.sh"
export JSC_BUILD_DIR
# rquickjs-sys isn't built here, but sqlite's cc build uses the same wasi-sdk.
export WASI_SDK="${WASI_SDK:-$WASI_SDK_PATH}"
[[ -f "$JSC_OBJ/lib/libJavaScriptCore.a" ]] || {
  echo "error: JSC prebuild at $JSC_BUILD_DIR is incomplete; run JSC_BUILD_DIR=$JSC_BUILD_DIR scripts/build-jsc.sh." >&2
  exit 1
}
# jsc/webkit-wasi.patch gives WTF's StackBounds a native recursion budget (docs/stack-limits.md).
# A WTF built before that links fine, but lets getters and Proxy traps exhaust the host's wasm stack.
if ! LC_ALL=C grep -qa BUN_WASM_STACK_KIB "$JSC_OBJ/lib/libWTF.a"; then
  echo "error: $JSC_OBJ/lib/libWTF.a was built without the StackBounds budget in jsc/webkit-wasi.patch." >&2
  echo "Update that one file and rebuild; ninja then recompiles only StackBounds.cpp and relinks:" >&2
  echo "  git -C $WEBKIT_DIR checkout -- Source/WTF/wtf/StackBounds.cpp" >&2
  echo "  git -C $WEBKIT_DIR apply --include=Source/WTF/wtf/StackBounds.cpp $JSC_SRC/webkit-wasi.patch" >&2
  echo "  scripts/build-jsc.sh" >&2
  exit 1
fi

embedding_inputs=$(bun "$root/scripts/jsc-embedding.ts" inputs)
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
guest_inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")
trap 'rm -f -- "$guest_inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun "$root/scripts/guest-build-receipt.ts" inputs jsc > "$guest_inputs"
export BUN_CORE_BUILD_DIR="${BUN_CORE_BUILD_DIR:-$CARGO_TARGET_DIR/split-common}"
export CARGO_BUILD_JOBS="${JOBS:-4}"
export JSC_ENGINE_BUILD_DIR="${JSC_ENGINE_BUILD_DIR:-$JSC_BUILD_DIR/engine}"
bun "$root/scripts/guest-core-receipt.ts" prepare jsc "$BUN_CORE_BUILD_DIR/bun-core.wasm" "$JSC_ENGINE_BUILD_DIR/engine.wasm"
"$root/scripts/build-bun-core.sh"
mkdir -p "$root/dist"
bun "$root/scripts/guest-core-receipt.ts" tag "$BUN_CORE_BUILD_DIR/bun-core.wasm" jsc "$root/dist/bun-jsc.wasm"
"$root/scripts/build-engine-jsc.sh"
cp "$JSC_ENGINE_BUILD_DIR/engine.wasm" "$root/dist/jsc-engine.wasm"
cp "$JSC_ENGINE_BUILD_DIR/engine.wasm.engine.json" "$root/dist/jsc-engine.wasm.engine.json"
raw="$BUN_CORE_BUILD_DIR/bun-core.wasm"
bun "$root/scripts/guest-build-receipt.ts" write "$root/dist/bun-jsc.wasm" "$guest_inputs"
bun "$root/scripts/jsc-embedding.ts" write "$root/dist/bun-jsc.wasm" "$embedding_inputs"
printf 'dist/bun-jsc.wasm: %s bytes (common core: %s bytes)\n' \
  "$(stat -c %s "$root/dist/bun-jsc.wasm")" "$(stat -c %s "$raw")"
printf 'dist/jsc-engine.wasm: %s bytes\n' "$(stat -c %s "$root/dist/jsc-engine.wasm")"
