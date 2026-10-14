#!/usr/bin/env bash
# Run the tests/build fixtures through native `bun build` and bun-build.wasm
# (wasmtime) and compare the output trees byte for byte, plus the printed
# summary with the "in Nms" timing masked.
#
#   scripts/test-build.sh                 # all fixtures
#   scripts/test-build.sh app split       # some fixtures
#
# Each fixture has a cases.txt: one set of `bun build` arguments per line,
# relative to the fixture directory. vendor/bun is newer than a release, so
# the exact reference is a canary build of the pinned commit (`bun --revision`
# ends in the BUN_COMMIT of scripts/sync-bun.sh), e.g. bun-linux-x64.zip from
# github.com/oven-sh/bun/releases/tag/canary while it still matches. Against
# bun 1.4.2, two cases differ through upstream changes made after 1.4.2.
# Env: BUN (native bun, default `bun`),
# NO_BUILD=1 (skip cargo build), KEEP=1 (keep the scratch dir),
# VERBOSE=1 (print diffs).
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=/dev/null
source "$root/env.sh"
bun_native=${BUN:-bun}

if [[ "${NO_BUILD:-0}" != 1 ]]; then
  (cd "$root" && cargo build -j "${JOBS:-12}" -p bunwasm-build --bin bun-build --release \
    --target wasm32-wasip1 >/dev/null 2>&1) || {
    echo "cargo build failed; rerun: cargo build -p bunwasm-build --bin bun-build --release --target wasm32-wasip1" >&2
    exit 2
  }
fi
wasm="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun-build.wasm"

scratch=$(mktemp -d /work/tmp/bun-wasm-build-test-XXXXXX)
if [[ "${KEEP:-0}" != 1 ]]; then
  trap 'rm -rf "$scratch"' EXIT
else
  echo "scratch: $scratch"
fi

# Precompile once so timings measure the build, not Cranelift.
cwasm="$scratch/bun-build.cwasm"
wasmtime compile "$wasm" -o "$cwasm"

# run <time-file> <dir> <cmd...>: run in <dir>, stdout+stderr to <dir>.log,
# "<seconds> <peak-rss-kib> <exit>" to <time-file>.
measure() {
  local tf=$1 dir=$2
  shift 2
  python3 - "$tf" "$dir" "$@" <<'PY'
import resource, subprocess, sys, time
tf, cwd, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]
t = time.monotonic()
with open(cwd + ".stdout", "wb") as out, open(cwd + ".stderr", "wb") as err:
    code = subprocess.call(cmd, cwd=cwd, stdout=out, stderr=err)
el = time.monotonic() - t
rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
open(tf, "w").write(f"{el:.3f} {rss} {code}\n")
PY
}

mask() { sed -E 's/ in [0-9]+ms/ in Nms/'; }

fixtures=("$@")
if [[ ${#fixtures[@]} -eq 0 ]]; then
  mapfile -t fixtures < <(find "$root/tests/build" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)
fi

pass=0
fail=0
report=()
for name in "${fixtures[@]}"; do
  src="$root/tests/build/$name"
  n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// /}" || "$line" == \#* ]] && continue
    n=$((n + 1))
    eval "args=($line)"
    case_dir="$scratch/$name-$n"
    mkdir -p "$case_dir"
    cp -r "$src/." "$case_dir/native"
    cp -r "$src/." "$case_dir/wasm"
    rm -f "$case_dir"/{native,wasm}/cases.txt

    measure "$case_dir/native.time" "$case_dir/native" "$bun_native" build "${args[@]}"
    measure "$case_dir/wasm.time" "$case_dir/wasm" \
      wasmtime run --allow-precompiled --dir "$case_dir/wasm::/proj" "$cwasm" --cwd /proj "${args[@]}"

    read -r nt nrss ncode <"$case_dir/native.time"
    read -r wt wrss wcode <"$case_dir/wasm.time"
    problems=()
    [[ "$ncode" == "$wcode" ]] || problems+=("exit $ncode vs $wcode")
    if ! diff -r "$case_dir/native" "$case_dir/wasm" >"$case_dir/tree.diff" 2>&1; then
      problems+=("output files differ")
    fi
    if ! diff <(mask <"$case_dir/native.stdout") <(mask <"$case_dir/wasm.stdout") >"$case_dir/stdout.diff"; then
      problems+=("stdout differs")
    fi
    if ! diff "$case_dir/native.stderr" "$case_dir/wasm.stderr" >"$case_dir/stderr.diff"; then
      problems+=("stderr differs")
    fi

    label="$name #$n: bun build $line"
    if [[ ${#problems[@]} -eq 0 ]]; then
      pass=$((pass + 1))
      echo "PASS  $label"
    else
      fail=$((fail + 1))
      echo "FAIL  $label  (${problems[*]})"
      if [[ "${VERBOSE:-0}" == 1 ]]; then
        cat "$case_dir/tree.diff" "$case_dir/stdout.diff" "$case_dir/stderr.diff" | head -60 | sed 's/^/      /'
      fi
    fi
    report+=("$(printf '%-8s %2d  %7.3fs %7.1f MiB   %7.3fs %7.1f MiB' "$name" "$n" \
      "$nt" "$(awk "BEGIN{print $nrss/1024}")" "$wt" "$(awk "BEGIN{print $wrss/1024}")")")
  done <"$src/cases.txt"
done

echo
echo "fixture  #   native time / peak RSS   wasm time / peak RSS"
for r in "${report[@]}"; do echo "$r"; done
echo
echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
