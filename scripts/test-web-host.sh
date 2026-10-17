#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
phase="${1:-all}"
case "$phase" in --setup|--unit|--browser|all) ;; *) echo "usage: $0 [--setup|--unit|--browser]" >&2; exit 2 ;; esac

if [[ "$phase" != --browser ]]; then
  # Both applications consume Waffle as the exact Git dependency recorded in their locks.
  (cd "$root/web" && bun install --frozen-lockfile)
  (cd "$root/sandbox" && bun install --frozen-lockfile)
  [[ "$phase" != --setup ]] || exit 0
  (
    cd "$root/web"
    node_modules/.bin/tsc -p ../crates/bunwasm-runtime/tsconfig.json
    bun test ../scripts/runtime-emission.test.ts ../scripts/runtime-types.test.ts ../scripts/runtime-signal-dispatch.test.ts ../scripts/worker-codec.test.ts ../scripts/worker-selectors.test.ts ../scripts/worker-outcome.test.ts ../scripts/spawn-runtime-proc.test.ts ../scripts/native-fixture-launchers.test.ts
    bun test ../scripts/browser-build.test.ts ../scripts/runtime-installed.test.ts ../scripts/runtime-size.test.ts
    bun run test
    PYTHONDONTWRITEBYTECODE=1 python3 ../scripts/test-bun-suite.py ProvenanceTests
    bun run check
    node_modules/.bin/tsc -p tests/engine-interruption.tsconfig.json
  )
  (cd "$root/sandbox" && bun run check)
  (cd "$root" && bun scripts/runtime-size.ts)
fi

if [[ "$phase" != --unit ]]; then
  cd "$root/web"
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
