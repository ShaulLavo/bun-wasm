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
bash "$root/scripts/test-web-host.sh" --unit
bun run build >/dev/null

scratch_root="${BUN_WASM_TEST_TMP:-${TMPDIR:-/tmp}}"
scratch=""
isolated_scratch=""
isolated_backups=()
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  for app in ${isolated_backups[@]+"${isolated_backups[@]}"}; do
    backup="$isolated_scratch/$app.bunfig.toml"
    if [[ -f "$backup" ]]; then
      cp "$backup" "$root/$app/bunfig.toml"
    else
      rm -f "$root/$app/bunfig.toml"
    fi
    # Put back the default layout, or the next typecheck sees two copies of waffle.
    (cd "$root/$app" && bun install --frozen-lockfile >/dev/null 2>&1) || true
  done
  rm -rf "$scratch" "$isolated_scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
scratch="$(mktemp -d "$scratch_root/bun-wasm-web-net-XXXXXX")"
isolated_scratch="$(mktemp -d "$scratch_root/bun-wasm-web-isolated-XXXXXX")"

printf '[install]\nlinker = "isolated"\n' >"$isolated_scratch/bunfig.toml"
for app in web sandbox site; do
  config="$root/$app/bunfig.toml"
  if [[ -e "$config" || -L "$config" ]]; then
    cp "$config" "$isolated_scratch/$app.bunfig.toml"
  fi
  isolated_backups+=("$app")
  cp "$isolated_scratch/bunfig.toml" "$config"
done
for app in web sandbox site; do
  (cd "$root/$app" && bun install --frozen-lockfile && bun run build >/dev/null)
done
(cd "$root/web" && bun test tests/build-splitting.test.ts)

bun "$root/tests/servers/http.ts" >"$scratch/port" &
server_pid=$!
for _ in $(seq 50); do [[ -s "$scratch/port" ]] && break; sleep 0.1; done
export TEST_SERVER="http://127.0.0.1:$(head -1 "$scratch/port")"

failed=0
# Both ways of installing the host functions: table slots (default) and calls through the WASI
# import (SLOTS=imports, the playground's ?slots=imports).
for slots in table imports; do
  for fixture in net-fetch net-serve net-node-http net-tcp net-bun-tcp net-http-upgrade net-ws-builtin; do
    dir="$root/tests/fixtures/$fixture"
    output="$scratch/$fixture-$slots.out"
    comparison="$scratch/$fixture-$slots.diff"
    if SLOTS=$slots node "$root/scripts/run-with-timeout.mts" 60 bun scripts/run.ts "$root/dist/bun.wasm" -e "$(cat "$dir/index.js")" >"$output" 2>&1 &&
      diff -u "$dir/expected.txt" "$output" >"$comparison"; then
      echo "ok   cli $fixture ($slots)"
    else
      echo "FAIL cli $fixture ($slots)"
      cat "$output"
      if [[ -s "$comparison" ]]; then cat "$comparison"; fi
      failed=1
    fi
  done
done

if [[ $browser == 1 ]]; then
  node --test "$root/sandbox/tests/first-visit-lifecycle.test.ts" || failed=1
  bash "$root/scripts/test-web-host.sh" --browser || failed=1
  bun tests/browser-editor.ts webkit || failed=1
  bun tests/browser-filesystem-lifecycle.ts chromium || failed=1
  bun tests/browser-filesystem-lifecycle.ts webkit || failed=1
  storage_runner="$(cd "$root/web" && realpath node_modules/waffle/tests/storage-browser-runner.ts)"
  if [[ -f "$storage_runner" ]]; then
    bun "$storage_runner" chromium webkit || failed=1
  else
    echo "missing installed Waffle storage browser runner: $storage_runner" >&2
    failed=1
  fi
  node tests/browser-install.mjs || failed=1
  node tests/browser-installer-links.ts || failed=1
  node tests/browser-shell-stop.ts || failed=1
  node tests/browser-net.mjs || failed=1
  node tests/browser-web-workers.ts || failed=1
  bun tests/browser-subprocess.ts || failed=1
  bun tests/browser-module-retry.ts || failed=1
  bun tests/browser-interrupt.ts chromium firefox webkit || failed=1
  bun tests/browser-runtime-proc.ts chromium webkit || failed=1
  node tests/browser-stack.mjs || failed=1
  if [[ -f "$root/dist/bun-jsc.wasm" && -f "$root/dist/bun-browser.wasm" ]]; then
    bun tests/browser-engine-interruption.ts || failed=1
  else
    echo "skip engine interruption: needs dist/bun-jsc.wasm and dist/bun-browser.wasm alongside bun.wasm"
  fi
  if [[ -f "$root/dist/bun-browser.wasm" ]]; then
    node tests/browser-worker-modules.ts || failed=1
    node tests/browser-engine.mjs || failed=1
    node tests/browser-tools.ts || failed=1
    node tests/browser-crypto.mjs || failed=1
    node tests/browser-memory.mjs || failed=1
  else
    echo "skip browser engine: no dist/bun-browser.wasm (scripts/build-bun-browser.sh)"
  fi
fi
exit $failed
