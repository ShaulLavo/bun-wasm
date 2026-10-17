#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
phase="${1:-all}"
case "$phase" in --unit|--browser|all) ;; *) echo "usage: $0 [--unit|--browser]" >&2; exit 2 ;; esac
cd "$root/web"

if [[ "$phase" != --browser ]]; then
  bun install --frozen-lockfile
  node_modules/.bin/tsc -p ../crates/bunwasm-runtime/tsconfig.json
  bun test ../scripts/runtime-emission.test.ts ../scripts/runtime-types.test.ts ../scripts/worker-codec.test.ts ../scripts/worker-selectors.test.ts ../scripts/worker-outcome.test.ts
  bun install --cwd ../runtime --frozen-lockfile
  bun install --cwd ../sandbox --frozen-lockfile
  bun run test
  bun test ../runtime/tests ../scripts/runtime-size.test.ts
  PYTHONDONTWRITEBYTECODE=1 python3 ../scripts/test-bun-suite.py ReportTests.test_browser_provenance_hashes_runtime_core
  bun run check
  bun run --cwd ../runtime check
  bun run --cwd ../sandbox check
  bun ../scripts/runtime-size.ts
fi

if [[ "$phase" != --unit ]]; then
  export SMOKE_PORT="${SMOKE_PORT:-4179}"
  listeners=$(ss -H -ltn "sport = :$SMOKE_PORT")
  test -z "$listeners"
  bun run test:browser
  SPLIT_SMOKE_PORT="${SPLIT_SMOKE_PORT:-4180}" bun tests/browser-splitting.mjs
  PLAYWRIGHT="$root/web/node_modules/playwright/index.mjs" node ../scripts/test-native-stream-interop.mjs
  FS_SMOKE_PORT="${FS_SMOKE_PORT:-4181}" bun tests/browser-filesystem.ts
  PERSIST_SMOKE=1 PERSIST_STORAGE=indexeddb PERSISTENCE_PORT="${PERSISTENCE_PORT:-4182}" bun tests/browser-persistence.ts chromium
  PERSIST_SMOKE=1 PERSIST_STORAGE=opfs PERSISTENCE_PORT="${PERSISTENCE_PORT:-4182}" bun tests/browser-persistence.ts chromium
  EDITOR_PORT="${EDITOR_PORT:-4183}" bun tests/browser-editor.ts chromium
fi
