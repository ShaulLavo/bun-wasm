#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-builtins-codegen-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT INT TERM
mkdir -p "$scratch/types"
TARGET_PLATFORM=linux TARGET_ARCH=x64 bun "$root/vendor/bun/src/codegen/bundle-modules.ts" \
  --debug=OFF "$scratch" "$scratch/types"
node "$root/scripts/generate-bun-builtins.mjs" "$scratch" "$@"
node "$root/scripts/generate-bun-console.mjs" "$@"
