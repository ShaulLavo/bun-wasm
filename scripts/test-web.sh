#!/usr/bin/env bash
# Tests for the browser host (web/): type check, unit tests, the network fixtures under the CLI shim
# (web/scripts/run.ts, same NetHost/NetHelper code as the page), then Chromium and WebKit via
# playwright (web/tests/browser-net.mjs), and the Browser (native) engine smoke test
# (web/tests/browser-engine.mjs) when dist/bun-browser.wasm exists (scripts/build-bun-browser.sh).
# Needs dist/bun.wasm (scripts/build.sh). No public internet.
#   scripts/test-web.sh            # everything
#   scripts/test-web.sh --no-browser
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
browser=1
[[ "${1:-}" == "--no-browser" ]] && browser=0

for test_file in "$root"/web/tests/*.mjs; do
  node --check "$test_file"
done

cd "$root/web"
bun run check
bun test tests/
bun run build >/dev/null

scratch="$(mktemp -d /work/tmp/bun-wasm-web-net-XXXXXX)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

bun "$root/tests/servers/http.ts" >"$scratch/port" &
server_pid=$!
for _ in $(seq 50); do [[ -s "$scratch/port" ]] && break; sleep 0.1; done
export TEST_SERVER="http://127.0.0.1:$(head -1 "$scratch/port")"

failed=0
# Both ways of installing the host functions: table slots (default) and calls through the WASI
# import (SLOTS=imports, the playground's ?slots=imports).
for slots in table imports; do
  for fixture in net-fetch net-serve net-node-http; do
    dir="$root/tests/fixtures/$fixture"
    if SLOTS=$slots timeout 60 bun scripts/run.ts "$root/dist/bun.wasm" -e "$(cat "$dir/index.js")" >"$scratch/$fixture.out" 2>&1 &&
      diff -u "$dir/expected.txt" "$scratch/$fixture.out" >"$scratch/$fixture.diff"; then
      echo "ok   cli $fixture ($slots)"
    else
      echo "FAIL cli $fixture ($slots)"
      cat "$scratch/$fixture.diff" 2>/dev/null || tail -20 "$scratch/$fixture.out"
      failed=1
    fi
  done
done

if [[ $browser == 1 ]]; then
  node tests/browser-install.mjs || failed=1
  node tests/browser-net.mjs || failed=1
  node tests/browser-subprocess.mjs || failed=1
  node tests/browser-stack.mjs || failed=1
  if [[ -f "$root/dist/bun-browser.wasm" ]]; then
    node tests/browser-engine.mjs || failed=1
    node tests/browser-crypto.mjs || failed=1
    node tests/browser-memory.mjs || failed=1
  else
    echo "skip browser engine: no dist/bun-browser.wasm (scripts/build-bun-browser.sh)"
  fi
fi
exit $failed
