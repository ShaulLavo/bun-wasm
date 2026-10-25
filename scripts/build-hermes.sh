#!/usr/bin/env bash
# Build the Hermes VM for wasm32-wasip1 (hermes/build.sh) into ${HERMES_BUILD_DIR:-/work/tmp/bun-wasm-hermes}:
#   hermes/  the patched checkout   host/  hermesc for the host   wasi/lib/libhermesvm_bunwasm.a
# See docs/hermes-engine.md.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/hermes/common.sh"
bun "$REPO/scripts/build-wasi-sysroot.ts"
"$root/hermes/build.sh"
