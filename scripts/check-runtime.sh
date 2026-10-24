#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
# Web CI owns the shared runtime type project and overlapping probes.
if [[ "${BUN_WASM_CI_CHECKS:-0}" == 1 ]]; then
  bun "$root/scripts/test-checks.ts" runtime
  exit $?
fi
if [[ ! -x "$root/web/node_modules/.bin/tsc" ]]; then
  echo 'Install the typechecker first: bun install --cwd web --frozen-lockfile' >&2
  exit 1
fi
"$root/web/node_modules/.bin/tsc" -p "$root/crates/bunwasm-runtime/tsconfig.json"
bun "$root/scripts/test-checks.ts" local-runtime
