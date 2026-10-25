# Sourced by the hermes/*.sh scripts: pinned revision, paths and the memory cage.
set -euo pipefail
HERMES_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERMES_SRC/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO/env.sh"
HERMES_BUILD_DIR="${HERMES_BUILD_DIR:-/work/tmp/bun-wasm-hermes}"
HERMES_DIR="$HERMES_BUILD_DIR/hermes"
# Host build: hermesc compiles Hermes's internal JavaScript to bytecode during the wasm build.
HERMES_HOST="$HERMES_BUILD_DIR/host"
HERMES_OBJ="$HERMES_BUILD_DIR/wasi"
HERMES_LIB="$HERMES_OBJ/lib/libhermesvm_bunwasm.a"
JOBS="${JOBS:-6}"
# facebook/hermes main, 2026-10-23 ("Move isCachedUsingEpoch to HiddenClass (#1939)").
HERMES_COMMIT=c36356f416ee19bb0d54c2e7ecb3c5fb0538a065
CAGE="${CAGE-systemd-run --user --scope -q -p MemoryMax=5G -p CPUWeight=20 nice -n 10}"
mkdir -p "$HERMES_BUILD_DIR"
