#!/usr/bin/env bash
# Regenerate Bun's browser HMR/overlay from the pinned bake sources.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-bake-codegen-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
bun "$root/vendor/bun/src/codegen/bake-codegen.ts" --codegen-root="$scratch" --debug=false
for name in client error; do
  source_file="$scratch/bake.$name.js"
  output="$root/crates/bunwasm-build/generated/bake.$name.js"
  if [[ "${1:-}" == --check ]]; then
    cmp "$source_file" "$output"
  else
    cp "$source_file" "$output"
  fi
done
