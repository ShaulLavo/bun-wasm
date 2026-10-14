#!/usr/bin/env bash
# tests/bench/micro.js under both engines: dist/bun.wasm (QuickJS) and dist/bun-jsc.wasm (JSC,
# C loop). Each engine runs RUNS times (default 3); compiled modules come from a wasmtime cache
# in $JSC_BUILD_DIR so compile time is not counted.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
jsc_build="${JSC_BUILD_DIR:-/work/tmp/bun-wasm-jsc}"
mkdir -p "$jsc_build/wasmtime-cache"
printf '[cache]\ndirectory = "%s"\n' "$jsc_build/wasmtime-cache" >"$jsc_build/wasmtime-cache.toml"
for engine in bun.wasm bun-jsc.wasm; do
  echo "== $engine ($(stat -c %s "$root/dist/$engine") bytes)"
  for _ in $(seq "${RUNS:-3}"); do
    start=$(date +%s%N)
    wasmtime run -C cache-config="$jsc_build/wasmtime-cache.toml" --dir "$root/tests/bench::/" "$root/dist/$engine" run /micro.js
    echo "total    $(( ($(date +%s%N) - start) / 1000000 )) ms wall (startup included)"
  done
done
