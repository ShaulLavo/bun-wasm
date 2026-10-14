#!/usr/bin/env bash
# End-to-end fixtures: build dist/bun.wasm, run every tests/fixtures/<name>
# under wasmtime and diff stdout (and the exit code) against expectations.
#
# A fixture directory holds:
#   index.{js,mjs,cjs,ts,tsx}   entry point (run as `bun run /index.*`)
#   expected.txt                expected stdout (what native Bun 1.4.2 prints)
#   expected_exit               optional expected exit code (default 0)
#   args                        optional extra program arguments, one per line
#   cmd                         optional: bun arguments replacing `run /index.*`, one per line
#   stdin                       optional file piped to stdin
#   manual                      optional marker: expected.txt is hand-written because native
#                               Bun legitimately differs (version numbers, real sockets), and
#                               --update leaves it alone
#
# The fixture is copied to a scratch directory that is preopened as `/`, so
# tests may write files freely. Use relative paths for files a test creates:
# `--update` runs native Bun in the scratch copy, where absolute paths would
# land on the real filesystem.
#
#   scripts/test.sh [--no-build] [--update] [name...]
#     --update   regenerate expected.txt with native `bun` (review the diff!)
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"

build=1
update=0
names=()
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --update) update=1 ;;
    *) names+=("$arg") ;;
  esac
done

if [[ $build == 1 && $update == 0 ]]; then
  "$root/scripts/build.sh" >/dev/null || { echo "build failed"; exit 1; }
fi
wasm="$root/dist/bun.wasm"

scratch="$(mktemp -d /work/tmp/bun-wasm-runtime-test-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT INT TERM

if [[ ${#names[@]} == 0 ]]; then
  for dir in "$root"/tests/fixtures/*/; do names+=("$(basename "$dir")"); done
fi

entry_of() {
  local dir="$1" f
  for f in index.js index.mjs index.cjs index.ts index.tsx index.jsx; do
    [[ -f "$dir/$f" ]] && { echo "$f"; return; }
  done
}

pass=0
fail=0
failed=()
for name in "${names[@]}"; do
  src="$root/tests/fixtures/$name"
  work="$scratch/$name"
  rm -rf "$work" && cp -r "$src" "$work"
  entry="$(entry_of "$work")"
  args=()
  [[ -f "$work/args" ]] && mapfile -t args <"$work/args"
  if [[ -f "$work/cmd" ]]; then
    mapfile -t cmd <"$work/cmd"
  else
    cmd=(run "/$entry")
  fi
  stdin_file=/dev/null
  [[ -f "$work/stdin" ]] && stdin_file="$work/stdin"
  expected_exit=0
  [[ -f "$work/expected_exit" ]] && expected_exit="$(cat "$work/expected_exit")"

  if [[ $update == 1 && -f "$src/manual" ]]; then
    echo "skipped $name (manual)"
    continue
  fi
  if [[ $update == 1 ]]; then
    native_cmd=("${cmd[@]}")
    [[ ! -f "$work/cmd" ]] && native_cmd=(run "./$entry")
    (cd "$work" && HOME=/ bun "${native_cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>/dev/null)
    # Native runs live in the scratch dir; inside wasm the fixture is `/`.
    sed -e "s#$work/#/#g" -e "s#$work#/#g" "$scratch/out" >"$src/expected.txt"
    echo "updated $name"
    continue
  fi

  (cd "$work" && timeout 60 wasmtime run --dir "$work::/" --env PWD=/ --env HOME=/ --env BUNWASM_TEST=1 \
    "$wasm" "${cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>"$scratch/err")
  code=$?
  if diff -u "$src/expected.txt" "$scratch/out" >"$scratch/diff" && [[ "$code" == "$expected_exit" ]]; then
    pass=$((pass + 1))
    printf 'PASS %s\n' "$name"
    continue
  fi
  fail=$((fail + 1))
  failed+=("$name")
  printf 'FAIL %s (exit %s, expected %s)\n' "$name" "$code" "$expected_exit"
  head -40 "$scratch/diff"
  [[ -s "$scratch/err" ]] && { echo "--- stderr:"; head -20 "$scratch/err"; }
done

[[ $update == 1 ]] && exit 0
echo
echo "$pass passed, $fail failed"
[[ $fail == 0 ]] || { printf 'failed: %s\n' "${failed[*]}"; exit 1; }
