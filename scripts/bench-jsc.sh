#!/usr/bin/env bash
# tests/bench/micro.js under both engines: dist/bun.wasm (QuickJS) and dist/bun-jsc.wasm (JSC,
# C loop). Each engine runs RUNS times (default 3) through the native runtime_proc host;
# compiled modules use the launcher cache (BUN_WASM_CACHE_DIR overrides its location).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
launcher="${BUN_WASM_LAUNCHER:-$CARGO_TARGET_DIR/release/bun-wasm}"
for engine in bun.wasm bun-jsc.wasm; do
  echo "== $engine ($(stat -c %s "$root/dist/$engine") bytes)"
  for _ in $(seq "${RUNS:-3}"); do
    start=$(date +%s%N)
    "$launcher" --wasm "$root/dist/$engine" --dir "$root/tests/bench::/" --env PWD=/ -- run /micro.js
    echo "total    $(( ($(date +%s%N) - start) / 1000000 )) ms wall (startup included)"
  done
done
