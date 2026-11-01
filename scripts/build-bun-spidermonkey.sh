#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root"
: "${SPIDERMONKEY_NATIVE_DIR:?Set SPIDERMONKEY_NATIVE_DIR to verified G3 native inputs}"
: "${SPIDERMONKEY_ENGINE_BUILD_DIR:?Set SPIDERMONKEY_ENGINE_BUILD_DIR to a private output directory}"
: "${BUN_CORE_BUILD_DIR:?Set BUN_CORE_BUILD_DIR to a private output directory}"
guest_environment=$(bun scripts/guest-build-receipt.ts environment)
eval "$guest_environment"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
inputs=''
trap 'rm -f -- "$inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
inputs=$(mktemp "$TMPDIR/bun-spidermonkey-inputs-XXXXXX")
bun scripts/guest-build-receipt.ts inputs spidermonkey > "$inputs"
bun scripts/guest-core-receipt.ts prepare spidermonkey "$BUN_CORE_BUILD_DIR/bun-core.wasm" "$SPIDERMONKEY_ENGINE_BUILD_DIR/engine.wasm"
scripts/build-bun-core.sh
scripts/build-engine-spidermonkey.sh
mkdir -p dist
bun scripts/guest-core-receipt.ts tag "$BUN_CORE_BUILD_DIR/bun-core.wasm" spidermonkey dist/bun-spidermonkey.wasm
cp "$SPIDERMONKEY_ENGINE_BUILD_DIR/engine.wasm" dist/spidermonkey-engine.wasm
cp "$SPIDERMONKEY_ENGINE_BUILD_DIR/engine.wasm.engine.json" dist/spidermonkey-engine.wasm.engine.json
bun scripts/guest-build-receipt.ts write dist/bun-spidermonkey.wasm "$inputs"
