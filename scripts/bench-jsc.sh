#!/usr/bin/env bash
# Alternate QuickJS and JSC through the full engine comparison benchmark.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
if [[ $# -eq 0 ]]; then
  set -- --engine "quickjs=$root/dist/bun.wasm" --engine "jsc=$root/dist/bun-jsc.wasm" --runs "${RUNS:-3}"
fi
exec bun "$root/scripts/bench-engines.ts" "$@"
