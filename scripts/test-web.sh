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
browser_test() { node "$root/scripts/run-with-timeout.mts" "${BROWSER_TEST_TIMEOUT_SECONDS:-300}" "$@"; }
browser=1
[[ "${1:-}" == "--no-browser" ]] && browser=0

for test_file in "$root"/web/tests/*.mjs; do
  node --check "$test_file"
done

cd "$root/web"
bash "$root/scripts/test-web-host.sh" --unit
bun run build >/dev/null

scratch_root="${BUN_WASM_TEST_TMP:-${TMPDIR:-/tmp}}"
isolated_scratch=""
isolated_backups=()
cleanup() {
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
  rm -rf "$isolated_scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
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

failed=0
bun "$root/scripts/legacy-cli.ts" || failed=1

if [[ $browser == 1 ]]; then
  browser_test node --test "$root/sandbox/tests/first-visit-lifecycle.test.ts" || failed=1
  bash "$root/scripts/test-web-host.sh" --browser || failed=1
  browser_test bun tests/browser-editor.ts webkit || failed=1
  browser_test bun tests/browser-filesystem-lifecycle.ts chromium || failed=1
  browser_test bun tests/browser-filesystem-lifecycle.ts webkit || failed=1
  storage_runner="$(cd "$root/web" && realpath node_modules/waffle/tests/storage-browser-runner.ts)"
  if [[ -f "$storage_runner" ]]; then
    browser_test bun "$storage_runner" chromium webkit || failed=1
  else
    echo "missing installed Waffle storage browser runner: $storage_runner" >&2
    failed=1
  fi
  browser_test node tests/browser-install.mjs || failed=1
  browser_test node tests/browser-installer-links.ts || failed=1
  browser_test node tests/browser-shell-stop.ts || failed=1
  browser_test node tests/browser-net.mjs || failed=1
  browser_test node tests/browser-web-workers.ts || failed=1
  browser_test bun tests/browser-subprocess.ts || failed=1
  browser_test bun tests/browser-module-retry.ts || failed=1
  browser_test bun tests/browser-interrupt.ts chromium firefox webkit || failed=1
  browser_test bun tests/browser-runtime-proc.ts chromium webkit || failed=1
  browser_test node tests/browser-stack.mjs || failed=1
  missing_interruption=()
  for artifact in bun.wasm bun-jsc.wasm bun-browser.wasm; do
    [[ -f "$root/dist/$artifact" ]] || missing_interruption+=("dist/$artifact")
  done
  if (( ${#missing_interruption[@]} == 0 )); then
    browser_test bun run test:browser:engine-interruption || failed=1
  else
    echo "SKIPPED engine interruption: missing ${missing_interruption[*]}"
  fi
  if [[ -f "$root/dist/bun-browser.wasm" ]]; then
    (cd "$root/tests/fixtures/worker-wasm" && bun install --frozen-lockfile --ignore-scripts)
    browser_test bun tests/browser-wasm-transfer.ts chromium webkit || failed=1
    browser_test node tests/browser-worker-modules.ts || failed=1
    browser_test node tests/browser-async-context-runtime.ts || failed=1
    browser_test node tests/browser-engine.mjs || failed=1
    browser_test node tests/browser-tools.ts || failed=1
    browser_test node tests/browser-crypto.mjs || failed=1
    browser_test node tests/browser-memory.mjs || failed=1
  else
    echo "skip browser engine: no dist/bun-browser.wasm (scripts/build-bun-browser.sh)"
  fi
fi
exit $failed
