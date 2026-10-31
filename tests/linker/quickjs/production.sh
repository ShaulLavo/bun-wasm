#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
source env.sh
: "${BUN_CORE_BUILD_DIR:?Set BUN_CORE_BUILD_DIR to a lane-private output directory}"
scripts/build.sh
export BUN_PROGRAM_DIR="$root/dist"
bun test tests/linker/quickjs/cli.test.ts
