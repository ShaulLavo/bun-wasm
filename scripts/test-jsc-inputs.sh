#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-jsc-inputs-test-XXXXXX)"
patch_backup="$scratch/webkit-wasi.patch"
cp "$root/jsc/webkit-wasi.patch" "$patch_backup"
cleanup() {
  cp "$patch_backup" "$root/jsc/webkit-wasi.patch"
  rm -rf "$scratch"
}
trap cleanup EXIT INT TERM

export JSC_BUILD_DIR="$scratch"
source "$root/jsc/common.sh"
write_jsc_inputs_stamp
check_jsc_inputs_stamp

message="error: the JSC prebuild at $JSC_BUILD_DIR was built from different JSC inputs; rebuild with JSC_BUILD_DIR=$JSC_BUILD_DIR scripts/build-jsc.sh (or point JSC_BUILD_DIR at a fresh directory)."
printf '\nchanged input\n' >> "$root/jsc/webkit-wasi.patch"
if output=$(check_jsc_inputs_stamp 2>&1); then
  echo "changed input unexpectedly passed" >&2
  exit 1
fi
[[ "$output" == "$message" ]] || { printf '%s\n' "$output" >&2; exit 1; }
cp "$patch_backup" "$root/jsc/webkit-wasi.patch"
rm "$JSC_INPUTS_STAMP"
if output=$(check_jsc_inputs_stamp 2>&1); then
  echo "missing stamp unexpectedly passed" >&2
  exit 1
fi
[[ "$output" == "$message" ]] || { printf '%s\n' "$output" >&2; exit 1; }
echo "jsc input stamp checks passed"
