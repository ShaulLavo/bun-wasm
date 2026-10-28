#!/usr/bin/env bash
# One optimized, untagged command core. This producer never builds an engine.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
source env.sh
guest_environment=$(bun "$root/scripts/guest-build-receipt.ts" environment)
eval "$guest_environment"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
out=${BUN_CORE_BUILD_DIR:?Set BUN_CORE_BUILD_DIR to a lane-private build directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
export CARGO_TARGET_DIR="$out/core-target"
export WASI_SDK="$WASI_SDK_PATH"
selected=engine-split,bun-transpiler,bun-build
profile='{"features":["engine-split","bun-transpiler","bun-build"]}'
if [[ "${1:-}" == --no-bun-transpiler ]]; then
  selected=engine-split
  profile='{"features":["engine-split"]}'
fi
features=(--no-default-features --features "$selected")
profile_file=''
inputs=''
trap 'rm -f -- "$profile_file" "$inputs"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
profile_file=$(mktemp "$TMPDIR/bun-core-profile-XXXXXX")
inputs=$(mktemp "$TMPDIR/bun-core-inputs-XXXXXX")
printf '%s\n' "$profile" > "$profile_file"
core="$out/bun-core.wasm"
bun "$root/scripts/guest-core-receipt.ts" prepare-core "$profile_file" "$core"
bun "$root/scripts/guest-core-receipt.ts" inputs "$profile_file" > "$inputs"
if [[ -e "$core" || -e "$core.core.json" ]]; then
  bun "$root/scripts/guest-core-receipt.ts" verify "$core" "$inputs"
  printf 'common core: verified reuse %s\n' "$core"
  exit 0
fi
"$GUEST_CARGO" tree --locked --offline -p bunwasm-cli --target wasm32-wasip1 "${features[@]}" > "$out/core-dependencies.txt"
if grep -Eq 'rquickjs|(^|[[:space:]])bunwasm-jsc[[:space:]]' "$out/core-dependencies.txt"; then
  echo 'core dependency graph contains a JavaScript VM' >&2
  exit 1
fi
"$GUEST_CARGO" build --locked --offline --release --target wasm32-wasip1 -j "${CARGO_BUILD_JOBS:-4}" -p bunwasm-cli "${features[@]}"
raw="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
wasm-opt -O2 -g --strip-dwarf --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals "$raw" -o "$core"
wasm-tools validate "$core"
bun "$root/scripts/guest-core-receipt.ts" write "$core" "$inputs"
sha256sum "$core" > "$out/artifact-sha256.txt"
git rev-parse HEAD > "$out/source-revision.txt"
git diff --binary HEAD > "$out/source-diff.patch"
