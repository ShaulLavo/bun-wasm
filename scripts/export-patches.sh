#!/usr/bin/env bash
# Export vendor/bun's `wasm` branch commits as patches/bun/*.patch.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
base=$(grep -oP 'BUN_COMMIT=\K[0-9a-f]+' "$root/scripts/sync-bun.sh")
rm -f "$root"/patches/bun/*.patch
git -C "$root/vendor/bun" format-patch -q --no-signature -o "$root/patches/bun" "$base..wasm"
ls "$root/patches/bun"
