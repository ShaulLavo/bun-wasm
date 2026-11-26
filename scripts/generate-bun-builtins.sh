#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-builtins-codegen-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT INT TERM
mkdir -p "$scratch/types"
# Bun stamps its builtin registry with the engine version. The lowered output does not carry the stamp.
webkit=$(grep -oP 'WEBKIT_VERSION = "\K[0-9a-f]+' "$root/vendor/bun/scripts/build/deps/webkit.ts")
TARGET_PLATFORM=linux TARGET_ARCH=x64 bun "$root/vendor/bun/src/codegen/bundle-modules.ts" \
  --debug=OFF "$scratch" "$scratch/types" "--webkit-version=$webkit"
node "$root/scripts/generate-bun-builtins.mjs" "$scratch" "$@"
node "$root/scripts/generate-bun-console.mjs" "$@"
