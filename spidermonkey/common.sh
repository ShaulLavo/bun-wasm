# Shared SpiderMonkey build settings. Source from the repository root's build scripts.
set -euo pipefail

SPIDERMONKEY_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SPIDERMONKEY_SRC/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO/env.sh"

SPIDERMONKEY_BUILD_DIR="${SPIDERMONKEY_BUILD_DIR:?set a lane-private build tree under /work/tmp}"
SPIDERMONKEY_DIR="$SPIDERMONKEY_BUILD_DIR/firefox"
SPIDERMONKEY_OBJDIR="$SPIDERMONKEY_BUILD_DIR/obj"
SPIDERMONKEY_LIB="$SPIDERMONKEY_BUILD_DIR/libspidermonkey_bunwasm.a"
SPIDERMONKEY_RECEIPT_DIR="$SPIDERMONKEY_BUILD_DIR/receipt"
JOBS="${JOBS:-6}"
CAGE="${CAGE-}"

# Mozilla main at the completed WASI and WASI-PBL builds recorded in the plan.
SPIDERMONKEY_COMMIT="a5df22d986d4b626f771b4f8885241941601c35c"

mkdir -p "$SPIDERMONKEY_BUILD_DIR" "$SPIDERMONKEY_RECEIPT_DIR"
