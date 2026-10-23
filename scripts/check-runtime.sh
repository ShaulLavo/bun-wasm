#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
if [[ ! -x "$root/web/node_modules/.bin/tsc" ]]; then
  echo 'Install the typechecker first: bun install --cwd web --frozen-lockfile' >&2
  exit 1
fi
"$root/web/node_modules/.bin/tsc" -p "$root/crates/bunwasm-runtime/tsconfig.json"
bun test "$root/scripts/net-listener.test.ts" "$root/scripts/yaml-coercion.test.ts" "$root/scripts/event-emitter-async-resource.test.ts" "$root/scripts/runtime-js.test.ts" "$root/scripts/runtime-emission.test.ts" "$root/scripts/runtime-ts-small.test.ts" "$root/scripts/runtime-assert-util.test.ts" "$root/scripts/runtime-types.test.ts" "$root/scripts/runtime-utilities.test.ts" "$root/scripts/runtime-signal-dispatch.test.ts" "$root/scripts/worker-codec.test.ts" "$root/scripts/worker-selectors.test.ts" "$root/scripts/worker-outcome.test.ts" "$root/scripts/spawn-runtime-proc.test.ts"
