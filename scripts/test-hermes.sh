#!/usr/bin/env bash
# Smoke tests for dist/bun-hermes.wasm (scripts/build-bun-hermes.sh) on the native launcher:
# `bun -e`, a TypeScript file on the shared bootstrap, and a Bun.serve round trip.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
launcher="${BUN_WASM_LAUNCHER:-$CARGO_TARGET_DIR/release/bun-wasm}"
wasm="${BUN_HERMES_WASM:-$root/dist/bun-hermes.wasm}"
run() {
  timeout 60 "$launcher" --wasm "$wasm" --dir "$root/tests/hermes::/" --env PWD=/ -- "$@"
}
expect() {
  local want="$1"
  shift
  local got
  got="$(run "$@")"
  if [[ "$got" != "$want" ]]; then
    printf 'FAIL bun %s\n  want: %s\n  got:  %s\n' "$*" "$want" "$got" >&2
    exit 1
  fi
  printf 'ok   bun %s\n' "$*"
}
expect "2" -e 'console.log(1 + 1)'
expect "object" -e 'console.log(typeof HermesInternal)'
expect "TypeError: boom" -e 'console.log(new TypeError("boom").stack.split("\n")[0])'
expect "hello 2" run /hello.ts
expect "200 hello from /hermes" run /serve.ts
