#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source env.sh
out=${BUN_CORE_BUILD_DIR:?Set BUN_CORE_BUILD_DIR to a lane-private build directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/core-target"
export WASI_SDK="$WASI_SDK_PATH"
selected=engine-quickjs,bun-transpiler,bun-build
if [[ "${1:-}" == --no-bun-transpiler ]]; then selected=engine-quickjs; fi
features=(--no-default-features --features "$selected")
cargo tree --locked --offline -p bunwasm-cli --target wasm32-wasip1 "${features[@]}" > "$out/core-dependencies.txt"
if grep -q rquickjs "$out/core-dependencies.txt"; then
  echo 'core dependency graph contains rquickjs' >&2
  exit 1
fi
cargo build --locked --offline --release --target wasm32-wasip1 -j "${CARGO_BUILD_JOBS:-4}" -p bunwasm-cli "${features[@]}"
cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm" "$out/bun-core.wasm"
QUICKJS_BUILD_DIR="$out/quickjs" scripts/build-engine-quickjs.sh
cp "$out/quickjs/engine.wasm" "$out/quickjs.wasm"
wasm-tools validate "$out/bun-core.wasm"
sha256sum "$out/bun-core.wasm" "$out/quickjs.wasm" > "$out/artifact-sha256.txt"
git rev-parse HEAD > "$out/source-revision.txt"
git diff --binary HEAD > "$out/source-diff.patch"
