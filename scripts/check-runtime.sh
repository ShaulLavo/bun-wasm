#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
if [[ ! -x "$root/web/node_modules/.bin/tsc" ]]; then
  echo 'Install the typechecker first: bun install --cwd web --frozen-lockfile' >&2
  exit 1
fi
"$root/web/node_modules/.bin/tsc" -p "$root/crates/bunwasm-runtime/tsconfig.json"
bun test "$root/scripts/runtime-js.test.ts"
