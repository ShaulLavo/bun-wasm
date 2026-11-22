#!/usr/bin/env bash
set -euo pipefail
deadline=$1
cap=$2
# Action timeouts accept whole minutes. Round down to stay within the deadline.
minutes=$(((deadline - EPOCHSECONDS) / 60))
if ((minutes <= 0)); then
  echo "Shared check has less than one minute remaining for the next action" >&2
  exit 124
fi
printf 'minutes=%d\n' "$((minutes < cap ? minutes : cap))" >> "$GITHUB_OUTPUT"
