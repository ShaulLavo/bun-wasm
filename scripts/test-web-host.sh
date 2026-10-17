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
  (cd "$root/web" && bun test ../scripts/browser-build.test.ts ../scripts/runtime-installed.test.ts && bun run test && bun run check)
  (cd "$root/sandbox" && bun run check)
  (cd "$root" && bun scripts/runtime-size.ts)
fi

if [[ "$phase" != --unit ]]; then
  (cd "$root/web" && bun run build >/dev/null && bun run test:browser)
fi
