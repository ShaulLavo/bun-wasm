#!/usr/bin/env bash
# Type-check vendored Bun crates for wasm32-wasip1 and summarize errors.
# usage: scripts/port-check.sh [crate=bun_transpiler] [extra cargo args]
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-port-target
crate=${1:-bun_transpiler}; shift || true
log=/work/tmp/bun-wasm-port.log
(cd "$root" && cargo check -j 12 -p "$crate" --target wasm32-wasip1 --keep-going --message-format short "$@") > "$log" 2>&1
status=$?
grep -E "^error: could not compile" "$log"
grep -E '^(vendor/bun/|crates/|third_party/)?[A-Za-z0-9_/.-]+\.rs:[0-9]+:[0-9]+: error' "$log" | sed 's|^vendor/bun/||' | sort -u | head -${MAXERR:-60}
echo "errors: $(grep -cE '\.rs:[0-9]+:[0-9]+: error' "$log")  exit: $status"
