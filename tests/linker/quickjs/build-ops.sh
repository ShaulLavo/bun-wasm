#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$PATH
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
source env.sh
out=${QUICKJS_BUILD_DIR:?Set QUICKJS_BUILD_DIR to a lane-private build directory}
sources=(
  crates/bunwasm-runtime/src/data.rs
  crates/bunwasm-runtime/src/ops.rs
  crates/bunwasm-runtime/src/data/codec.rs
  crates/bunwasm-runtime/src/ops/abi.rs
)
for path in "${sources[@]}"; do
  if [[ ! -f "$path" ]]; then
    printf 'QuickJS fixture requires committed data/ops source at %s. Merge PR235 (f331e002) or a descendant, then rerun.\n' "$path" >&2
    exit 1
  fi
  if ! git cat-file -e "HEAD:$path" 2>/dev/null; then
    printf 'QuickJS fixture source %s is not committed. Commit it instead of selecting an external worktree.\n' "$path" >&2
    exit 1
  fi
done
if ! git diff --quiet HEAD -- "${sources[@]}"; then
  printf 'QuickJS fixture data/ops sources have uncommitted changes. Commit them so the fixture revision is reproducible.\n' >&2
  exit 1
fi
mkdir -p "$out"
out=$(cd "$out" && pwd)
printf 'revision=%s\n' "$(git rev-parse HEAD)" > "$out/source-revision.txt"
for path in "${sources[@]}"; do
  printf '%s=%s\n' "$path" "$(git rev-parse "HEAD:$path")" >> "$out/source-revision.txt"
done
rustc --target wasm32-wasip1 --edition 2024 -C opt-level=s \
  -C panic=abort --crate-type=staticlib --cap-lints=allow \
  --remap-path-prefix "$root/=bun-wasm/" \
  tests/linker/quickjs/ops-core.rs -o "$out/ops-core.a"
