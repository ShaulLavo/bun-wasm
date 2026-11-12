#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/update-status-test.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir "$scratch/bin"
awk '
  /^      - name: Report each required result on the tested commit$/ { found=1 }
  found && /^        run: \|$/ { body=1; next }
  body && /^          / { sub(/^          /, ""); print; next }
  body { exit }
' "$root/.github/workflows/ci.yml" > "$scratch/report.sh"
test -s "$scratch/report.sh"
cat > "$scratch/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ ${FAIL_API:-0} == 0 ]] || exit 1
printf '%s\n' "$*" >> "$STATUS_LOG"
MOCK
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH" GH_TOKEN=fixture GH_REPO=ShaulLavo/fixture HEAD=tested-head RUN_URL=https://example.invalid/run STATUS_LOG="$scratch/statuses"
run_report() {
  : > "$STATUS_LOG"
  bash -euo pipefail "$scratch/report.sh"
  test "$(grep -c '^api --method POST repos/ShaulLavo/fixture/statuses/tested-head ' "$STATUS_LOG")" = 11
}
baseline=$(cat <<'JSON'
{"quality":{"result":"success","outputs":{"rust":"true","shared":"true"}},"jsc-prebuild":{"result":"success"},"native-quality":{"result":"success"},"rust":{"result":"success"},"package":{"result":"success"},"shared-sysroot":{"result":"success"},"web":{"result":"success"},"process-bundles":{"result":"success"},"browser-process":{"result":"success"}}
JSON
)
export RESULTS="$baseline"
run_report
test "$(grep -c -- '-f state=success ' "$STATUS_LOG")" = 11
while IFS='|' read -r context job selection; do
  for result in failure cancelled skipped; do
    export RESULTS
    RESULTS=$(jq --arg job "$job" --arg result "$result" '.[$job].result = $result' <<< "$baseline")
    run_report
    grep -Fq -- "-f context=$context -f state=failure " "$STATUS_LOG"
  done
  [[ -n "$selection" ]] || continue
  RESULTS=$(jq --arg job "$job" --arg selection "$selection" '.[$job].result = "skipped" | .quality.outputs[$selection] = "false"' <<< "$baseline")
  run_report
  test "$(grep -c -- '-f state=success ' "$STATUS_LOG")" = 11
  RESULTS=$(jq '.quality.result = "failure"' <<< "$RESULTS")
  run_report
  grep -Fq -- "-f context=$context -f state=failure " "$STATUS_LOG"
done <<'CASES'
Code quality|quality|
JSC C/C++ prebuild|jsc-prebuild|rust
Native quality checkpoint|native-quality|rust
Rust workspace tests (QuickJS host)|rust|rust
Browser adapter package|package|
Shared PIC sysroot proof|shared-sysroot|shared
Web host|web|
Shared process browser bundles|process-bundles|
Processes (chromium)|browser-process|
Processes (firefox)|browser-process|
Processes (webkit)|browser-process|
CASES
RESULTS=$(jq 'del(.quality)' <<< "$baseline")
if bash -euo pipefail "$scratch/report.sh"; then
  echo 'Missing CI result was accepted' >&2; exit 1
fi
export RESULTS="$baseline"

if FAIL_API=1 bash -euo pipefail "$scratch/report.sh"; then
  echo 'Status API failure was ignored' >&2; exit 1
fi
echo 'PASS: required statuses report the real tested results and API errors fail closed'
