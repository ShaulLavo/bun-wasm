#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-tcp-ws-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$scratch/node_modules"
cp -rL "$root/docs/bun-test-suite/dependencies/node_modules/ws" "$scratch/node_modules/ws"
cp "$root/tests/net-ws.mjs" "$scratch/index.mjs"
failed=0
wasm_dir="${1:-$root/dist}"
for engine in quickjs jsc browser; do
  wasm="$wasm_dir/bun.wasm"
  [[ "$engine" == jsc ]] && wasm="$wasm_dir/bun-jsc.wasm"
  [[ "$engine" == browser ]] && wasm="$wasm_dir/bun-browser.wasm"
  args=(--dir "$scratch::/" --env PWD=/ --env WS_NO_BUFFER_UTIL=1 --env WS_NO_UTF_8_VALIDATE=1)
  code=0
  if [[ "$engine" == browser ]]; then
    timeout 45 node --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$wasm" --net "${args[@]}" -- run /index.mjs || code=$?
  else
    timeout 45 "$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$wasm" "${args[@]}" run /index.mjs || code=$?
  fi
  if [[ $code == 0 ]]; then echo "ok $engine ws"; else echo "FAIL $engine ws ($code)"; failed=1; fi
done
exit "$failed"
