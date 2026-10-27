#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
source env.sh
: "${BUN_CORE_BUILD_DIR:?Set BUN_CORE_BUILD_DIR to a lane-private output directory}"
scripts/build-bun-core.sh
bun test tests/linker/quickjs/cli.test.ts
