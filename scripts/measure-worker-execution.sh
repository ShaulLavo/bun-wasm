#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$PATH
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
engine="${1:?usage: measure-worker-execution.sh quickjs|jsc|browser output.json}"
output="${2:?output.json required}"
suite="${BUN_SUITE:-$root/vendor/bun}"
launcher="$CARGO_TARGET_DIR/release/bun-wasm"
case "$engine" in
  quickjs) wasm="$root/dist/bun.wasm" ;;
  jsc) wasm="$root/dist/bun-jsc.wasm" ;;
  browser) wasm="$root/dist/bun-browser.wasm" ;;
  *) echo "unknown engine: $engine" >&2; exit 2 ;;
esac
mapfile -t selection < <(python3 - "$suite" <<'PY'
import re
import subprocess
import sys
from pathlib import Path
root = Path(sys.argv[1])
paths = subprocess.check_output(["git", "-C", str(root), "ls-files", "test/js/node/test/parallel"], text=True).splitlines()
pattern = re.compile(r"new\s+(?:\w+\.)?Worker\s*\(")
for path in sorted(paths):
    if path.endswith(".js") and pattern.search((root / path).read_text()):
        print(path.removeprefix("test/"))
PY
)
[[ "${#selection[@]}" == 120 ]] || { echo "expected the measured 120 worker-dependent Node scripts" >&2; exit 1; }
if [[ "$engine" != browser ]]; then timeout 180 "$launcher" --wasm "$wasm" -e 0 >/dev/null; fi
exec "$root/scripts/bun-suite.sh" --engine "$engine" --suite "$suite" --launcher "$launcher" \
  --jobs 2 --timeout 15 --output "$output" "${selection[@]}"
