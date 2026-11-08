#!/usr/bin/env bash
# Compose an experimental SpiderMonkey side with a generic untagged common core.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root"
: "${SPIDERMONKEY_NATIVE_DIR:?Set SPIDERMONKEY_NATIVE_DIR to a parent-admitted N1 input directory}"
: "${SPIDERMONKEY_ENGINE_BUILD_DIR:?Set SPIDERMONKEY_ENGINE_BUILD_DIR to a private output directory}"
: "${SPIDERMONKEY_PAIR_DIR:?Set SPIDERMONKEY_PAIR_DIR to a private fresh pair directory}"
: "${BUN_CORE_BUILD_DIR:?Set BUN_CORE_BUILD_DIR to a private output directory}"
bun scripts/spidermonkey-side-core-receipt.ts verify-native "$SPIDERMONKEY_NATIVE_DIR"
inputs=$(mktemp "$TMPDIR/bun-spidermonkey-side-inputs-XXXXXX")
trap 'rm -f -- "$inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun scripts/spidermonkey-side-core-receipt.ts inputs "$root" "$SPIDERMONKEY_NATIVE_DIR" > "$inputs"
[[ ! -e "$SPIDERMONKEY_PAIR_DIR" ]] || { echo "Refusing existing experimental pair output" >&2; exit 1; }
scripts/build-engine-spidermonkey.sh
scripts/build-bun-core.sh
mkdir "$SPIDERMONKEY_PAIR_DIR"
bun scripts/spidermonkey-side-core-receipt.ts inputs "$root" "$SPIDERMONKEY_NATIVE_DIR" > "$SPIDERMONKEY_PAIR_DIR/inputs.json"
cmp "$inputs" "$SPIDERMONKEY_PAIR_DIR/inputs.json"
bun scripts/spidermonkey-side-core-receipt.ts tag-core "$BUN_CORE_BUILD_DIR/bun-core.wasm" "$SPIDERMONKEY_PAIR_DIR/bun-spidermonkey.wasm"
cp "$SPIDERMONKEY_ENGINE_BUILD_DIR/engine.wasm" "$SPIDERMONKEY_PAIR_DIR/spidermonkey-engine.wasm"
bun scripts/spidermonkey-side-core-receipt.ts write-pair "$SPIDERMONKEY_PAIR_DIR/bun-spidermonkey.wasm" "$SPIDERMONKEY_PAIR_DIR/spidermonkey-engine.wasm" "$inputs"
