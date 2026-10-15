#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-builtins-test-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT INT TERM
cp "$root/tests/builtins/loader.js" "$scratch/index.js"
cp "$root/crates/bunwasm-runtime/src/js/bun_builtins.js" "$scratch/runtime.js"
cp "$root/crates/bunwasm-runtime/generated/builtins/"*.js "$scratch/"
cp "$root/crates/bunwasm-runtime/generated/builtins/catalog.json" "$scratch/catalog.json"
for engine in quickjs jsc browser; do
  case "$engine" in
    quickjs) wasm="$root/dist/bun.wasm" ;;
    jsc) wasm="$root/dist/bun-jsc.wasm" ;;
    browser) wasm="$root/dist/bun-browser.wasm" ;;
  esac
  if [[ "$engine" == browser ]]; then
    (cd "$scratch" && timeout 60 node --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$wasm" --dir "$scratch::/" --env PWD=/ -- run /index.js)
  else
    timeout 60 wasmtime run --dir "$scratch::/" --env PWD=/ "$wasm" run /index.js
  fi
  echo "PASS generated builtins ($engine)"
done
