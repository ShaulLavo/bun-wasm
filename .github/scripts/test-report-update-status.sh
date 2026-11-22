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
  test "$(grep -c '^api --method POST repos/ShaulLavo/fixture/statuses/tested-head ' "$STATUS_LOG")" = 1
}
baseline=$(cat <<'JSON'
{"selection":{"result":"success","outputs":{"rust":"true","browser_guest":"true","shared":"true"}},"quality":{"result":"success"},"web-unit":{"result":"success"},"web-browser":{"result":"success"},"native-quality":{"result":"success"},"ordinary-build":{"result":"success"},"rust":{"result":"success"},"rust-fixtures":{"result":"success"},"shared-sysroot":{"result":"success"},"browser-guest":{"result":"success"},"shared-consumers":{"result":"success"},"ci-result":{"result":"success"}}
JSON
)
export RESULTS="$baseline"
run_report
test "$(grep -c -- '-f state=success ' "$STATUS_LOG")" = 1
for result in failure cancelled skipped; do
  export RESULTS
  RESULTS=$(jq --arg result "$result" '."ci-result".result = $result' <<< "$baseline")
  run_report
  grep -Fq -- "-f context=Code quality -f state=failure " "$STATUS_LOG"
done
RESULTS=$(jq 'del(."ci-result")' <<< "$baseline")
if bash -euo pipefail "$scratch/report.sh"; then
  echo 'Missing CI result was accepted' >&2; exit 1
fi
export RESULTS="$baseline"

if FAIL_API=1 bash -euo pipefail "$scratch/report.sh"; then
  echo 'Status API failure was ignored' >&2; exit 1
fi
echo 'PASS: required statuses report the real tested results and API errors fail closed'
