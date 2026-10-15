#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
exec python3 "$root/scripts/bun-suite.py" "$@"
