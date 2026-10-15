#!/usr/bin/env bash
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root" || exit 1
vendor=${BUN_REALRT_SOURCE:-$root/vendor/bun}
codegen=${BUN_CODEGEN_DIR:?Set BUN_CODEGEN_DIR to completed Bun codegen output}
output=${1:-/work/reports/bun-wasm-realrt/rust-vendor}
export CARGO_TARGET_DIR=${REALRT_RUST_TARGET:-/work/tmp/bun-wasm-realrt-rust-target}
export BUN_CODEGEN_DIR=$codegen
mkdir -p "$(dirname "$output")" "$CARGO_TARGET_DIR" || exit 1
lock_backup=$(mktemp "$CARGO_TARGET_DIR/real-runtime-lock-XXXXXX") || exit 1
cp "$vendor/Cargo.lock" "$lock_backup" || { rm -f "$lock_backup"; exit 1; }
trap 'cp "$lock_backup" "$vendor/Cargo.lock"; rm -f "$lock_backup"' EXIT
systemd-run --user --scope -p MemoryMax=4G nice -n 5 \
  cargo check --manifest-path "$vendor/Cargo.toml" \
  --config "patch.crates-io.libc.path=\"$root/third_party/libc\"" \
  -j 6 -p bun_runtime -p bun_jsc --target wasm32-wasip1 --keep-going \
  --message-format=json >"$output.jsonl" 2>"$output.stderr"
status=$?
printf '%s\n' "$status" >"$output.exit"
python3 - "$output.jsonl" <<'PY'
import collections
import json
import sys

errors = []
for line in open(sys.argv[1]):
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if record.get('reason') != 'compiler-message':
        continue
    message = record['message']
    if message['level'] == 'error':
        errors.append((record['package_id'], message))
counts = collections.Counter(package for package, message in errors)
print(f'{len(errors)} compiler error diagnostics across {len(counts)} crates')
for package, count in sorted(counts.items()):
    print(f'{count}\t{package}')
for package, message in errors:
    spans = [span for span in message['spans'] if span['is_primary']]
    location = ', '.join(f"{s['file_name']}:{s['line_start']}" for s in spans)
    code = (message.get('code') or {}).get('code', '-')
    print(f"{code}\t{location}\t{message['message']}")
PY
exit "$status"
