#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-tcp-ws-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/node_modules"
cp -r "$root/docs/bun-test-suite/dependencies/node_modules/ws" "$scratch/node_modules/ws"
cp "$root/tests/net-ws.mjs" "$scratch/index.mjs"
for engine in quickjs jsc browser; do
  wasm="$root/dist/bun.wasm"
  [[ "$engine" == jsc ]] && wasm="$root/dist/bun-jsc.wasm"
  [[ "$engine" == browser ]] && wasm="$root/dist/bun-browser.wasm"
  args=(--dir "$scratch::/" --env PWD=/ --env WS_NO_BUFFER_UTIL=1 --env WS_NO_UTF_8_VALIDATE=1)
  if [[ "$engine" == browser ]]; then
    timeout 45 node --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$wasm" --net "${args[@]}" -- run /index.mjs
  else
    timeout 45 "$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$wasm" "${args[@]}" run /index.mjs
  fi
  echo "ok $engine ws"
done
