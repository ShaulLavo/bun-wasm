#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$PATH
root=$(cd "$(dirname "$0")/../../.." && pwd)
scratch=$(mktemp -d /work/tmp/bun-wasm-quickjs-path-XXXXXX)
created_a=0
created_b=0
cleanup() {
  if [[ "$created_a" == 1 ]]; then git -C "$root" worktree remove --force "$scratch/source-a"; fi
  if [[ "$created_b" == 1 ]]; then git -C "$root" worktree remove --force "$scratch/source-b"; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
git -C "$root" worktree add --detach "$scratch/source-a" HEAD
created_a=1
cp -a "$root/tests/linker/quickjs/." "$scratch/source-a/tests/linker/quickjs/"
git -C "$root" worktree add --detach "$scratch/source-b" HEAD
created_b=1
cp -a "$root/tests/linker/quickjs/." "$scratch/source-b/tests/linker/quickjs/"
QUICKJS_BUILD_DIR="$scratch/out-a" "$scratch/source-a/tests/linker/quickjs/build-ops.sh"
QUICKJS_BUILD_DIR="$scratch/out-b" "$scratch/source-b/tests/linker/quickjs/build-ops.sh"
cmp "$scratch/out-a/ops-core.a" "$scratch/out-b/ops-core.a"
cmp "$scratch/out-a/source-revision.txt" "$scratch/out-b/source-revision.txt"
if grep -a -q -F "$scratch/source-a" "$scratch/out-a/ops-core.a"; then
  printf 'First checkout path leaked into ops-core.a\n' >&2
  exit 1
fi
if grep -a -q -F "$scratch/source-b" "$scratch/out-b/ops-core.a"; then
  printf 'Second checkout path leaked into ops-core.a\n' >&2
  exit 1
fi
rm "$scratch/source-b/crates/bunwasm-runtime/src/data.rs"
if QUICKJS_BUILD_DIR="$scratch/missing" "$scratch/source-b/tests/linker/quickjs/build-ops.sh" > "$scratch/missing.log" 2>&1; then
  printf 'Missing data.rs unexpectedly passed\n' >&2
  exit 1
fi
grep -q 'requires committed data/ops source' "$scratch/missing.log"
sha256sum "$scratch/out-a/ops-core.a" "$scratch/out-b/ops-core.a"
printf 'Path-independent ops-core fixtures match; missing-source validation is actionable.\n'
