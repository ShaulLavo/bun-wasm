#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
exec bun "$root/scripts/app-matrix/run.mjs" "$@"
