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
#   expected_stderr.txt         optional expected stderr (e.g. `bun test` reports)
#   show                        optional list of files (one per line) the run creates; their
#                               contents are appended to stdout as `--- <path>` sections
#   manual                      optional marker: expected.txt is hand-written because native
#                               Bun legitimately differs (version numbers, real sockets), and
#                               --update leaves it alone
#
# Outputs are normalized before comparing: durations like `[1.23ms]` become
# `[TIME]` (dropped entirely on per-test `(pass) name` lines, which native Bun
# only times above 10µs), `bun test v1.4.2 (744846f84)` becomes `bun test vVERSION`, and the
# crash footer `Bun v1.4.2 (Linux x64)` becomes `Bun vVERSION (PLATFORM)`, and
# `bun build`'s "Bundled N modules in 12ms" loses its timing.
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

wasm="$root/dist/bun.wasm"

scratch="$(mktemp -d /work/tmp/bun-wasm-runtime-test-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT INT TERM

if [[ $build == 1 && $update == 0 ]]; then
  "$root/scripts/build.sh" >"$scratch/build.log" 2>&1 || { tail -30 "$scratch/build.log"; echo "build failed"; exit 1; }
fi

if [[ ${#names[@]} == 0 ]]; then
  for dir in "$root"/tests/fixtures/*/; do names+=("$(basename "$dir")"); done
fi

normalize() {
  sed -E -e 's/\[[0-9]+(\.[0-9]+)?m?s\]/[TIME]/g' \
    -e 's/^(\((pass|fail|skip|todo)\) .*) \[TIME\]$/\1/' -e 's/^bun test v[^ ]+ \([0-9a-f]+\)/bun test vVERSION/' \
    -e 's/^Bun v[0-9.]+ \([^)]*\)$/Bun vVERSION (PLATFORM)/' \
    -e 's/^Bundled ([0-9]+) modules? in [0-9]+ms/Bundled \1 modules in Nms/'
}

# Append the files listed in the fixture's `show` file to an output file.
show_files() {
  local dir="$1" out="$2" f
  [[ -f "$dir/show" ]] || return 0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    printf -- '--- %s\n' "$f" >>"$out"
    cat "$dir/$f" >>"$out" 2>/dev/null || echo "(missing)" >>"$out"
  done <"$dir/show"
}

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
    (cd "$work" && AGENT=0 CLAUDECODE= HOME=/ bun "${native_cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>"$scratch/err")
    show_files "$work" "$scratch/out"
    # Native runs live in the scratch dir; inside wasm the fixture is `/`.
    sed -e "s#$work/#/#g" -e "s#$work#/#g" "$scratch/out" | normalize >"$src/expected.txt"
    if [[ -f "$src/expected_stderr.txt" ]]; then
      sed -e "s#$work/#/#g" -e "s#$work#/#g" "$scratch/err" | normalize >"$src/expected_stderr.txt"
    fi
    echo "updated $name"
    continue
  fi

  (cd "$work" && timeout 60 wasmtime run --dir "$work::/" --env PWD=/ --env HOME=/ --env BUNWASM_TEST=1 \
    "$wasm" "${cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>"$scratch/err")
  code=$?
  show_files "$work" "$scratch/out"
  normalize <"$scratch/out" >"$scratch/out.n"
  normalize <"$scratch/err" >"$scratch/err.n"
  ok=1
  diff -u "$src/expected.txt" "$scratch/out.n" >"$scratch/diff" || ok=0
  if [[ -f "$src/expected_stderr.txt" ]]; then
    diff -u "$src/expected_stderr.txt" "$scratch/err.n" >>"$scratch/diff" || ok=0
  fi
  if [[ $ok == 1 && "$code" == "$expected_exit" ]]; then
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
