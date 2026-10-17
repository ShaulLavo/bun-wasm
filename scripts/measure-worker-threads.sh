#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$PATH
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
engine="${1:?usage: measure-worker-threads.sh quickjs|jsc|browser output.json}"
output="${2:?output.json required}"
suite="${BUN_SUITE:-$root/vendor/bun}"
launcher="$CARGO_TARGET_DIR/release/bun-wasm"
jobs=4
deadline=5
case "$engine" in
  quickjs) wasm="$root/dist/bun.wasm" ;;
  jsc) wasm="$root/dist/bun-jsc.wasm"; jobs=2; deadline=15 ;;
  browser) wasm="$root/dist/bun-browser.wasm" ;;
  *) echo "unknown engine: $engine" >&2; exit 2 ;;
esac
if [[ "$engine" != browser ]]; then
  timeout 180 "$launcher" --wasm "$wasm" -e '0' >/dev/null
fi
mapfile -t selection < <(git -C "$suite" ls-files test/js/node/test/parallel |
  command grep '\.js$' | LC_ALL=C sort | sed -n '1,160{s#^test/##;p;}')
[[ "${#selection[@]}" == 160 ]] || { echo "expected 160 tracked Node parallel scripts" >&2; exit 1; }
exec "$root/scripts/bun-suite.sh" --engine "$engine" --suite "$suite" --launcher "$launcher" \
  --jobs "$jobs" --timeout "$deadline" --output "$output" "${selection[@]}"
