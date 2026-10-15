#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
for engine in quickjs jsc browser; do
  "$root/scripts/test.sh" --no-build --engine "$engine" semver-host-functions host-gc-capture
done
python3 "$root/scripts/bun-jsc-inventory.py" --check "$root/docs/bun-jsc-inventory.json"
