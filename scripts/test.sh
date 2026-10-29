#!/usr/bin/env bash
# End-to-end fixtures: build dist/bun.wasm, run every tests/fixtures/<name>
# through the runtime_proc-capable hosts and diff stdout (and the exit code).
#
# A fixture directory holds:
#   index.{js,mjs,cjs,ts,tsx}   entry point (run as `bun run /index.*`)
#   expected.txt                expected stdout (what native Bun 1.4.2 prints)
#   expected_exit               optional expected exit code (default 0)
#   args                        optional extra program arguments, one per line
#   cmd                         optional: bun arguments replacing `run /index.*`, one per line
#   stdin                       optional file piped to stdin
#   expected_stderr.txt         optional expected stderr (e.g. `bun test` reports)
#   host                        optional marker: start the local networking test server;
#                               all native-engine fixtures use crates/bunwasm-host.
#                               TEST_SERVER=http://127.0.0.1:<port> points at
#                               tests/servers/http.ts, which this script starts
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
#   scripts/test.sh [--no-build] [--update] [--engine quickjs|jsc|hermes] [--context native|hooks] [name...]
#     --engine jsc      run dist/bun-jsc.wasm (JavaScriptCore; scripts/build-bun-jsc.sh)
#     --engine hermes   run dist/bun-hermes.wasm (Hermes, opt-in; scripts/build-bun-hermes.sh)
#     --engine browser  run dist/bun-browser.wasm with Node's V8 as the host engine
#                       (web/scripts/node-host.mjs; docs/engine-browser.md)
#     --context hooks   with --engine browser: carry AsyncLocalStorage with the printed
#                       hooks instead of Node's, as a browser does
#     --update   regenerate expected.txt with native `bun` (review the diff!)
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$root/env.sh"
"$root/scripts/check-runtime.sh" || exit $?

build=1
update=0
engine=quickjs
context=native
names=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) build=0 ;;
    --update) update=1 ;;
    --engine) engine="$2"; shift ;;
    --engine=*) engine="${1#--engine=}" ;;
    --context) context="$2"; shift ;;
    --context=*) context="${1#--context=}" ;;
    *) names+=("$1") ;;
  esac
  shift
done

case "$engine" in
  quickjs) wasm="$root/dist/bun.wasm"; build_script="$root/scripts/build.sh" ;;
  jsc) wasm="$root/dist/bun-jsc.wasm"; build_script="$root/scripts/build-bun-jsc.sh" ;;
  hermes) wasm="$root/dist/bun-hermes.wasm"; build_script="$root/scripts/build-bun-hermes.sh" ;;
  browser) wasm="$root/dist/bun-browser.wasm"; build_script="$root/scripts/build-bun-browser.sh" ;;
  *) echo "unknown engine $engine (quickjs, jsc, hermes or browser)"; exit 2 ;;
esac
case "$context" in
  native) ;;
  hooks) [[ $engine == browser ]] || { echo "--context hooks needs --engine browser"; exit 2; } ;;
  *) echo "unknown context $context (native or hooks)"; exit 2 ;;
esac

scratch="$(mktemp -d "$TMPDIR/bun-wasm-runtime-test-XXXXXX")"
server_pid=""
trap 'if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null; fi; rm -rf "$scratch"' EXIT INT TERM

if [[ $build == 1 && $update == 0 ]]; then
  "$build_script" >"$scratch/build.log" 2>&1 || {
    command grep -n -A16 -B2 -E 'error(\[|:)|panicked at' "$scratch/build.log" || tail -30 "$scratch/build.log"
    echo "build failed"
    exit 1
  }
fi

# Every native-engine guest imports runtime_proc, including non-network fixtures.
launcher="${BUN_WASM_LAUNCHER:-$CARGO_TARGET_DIR/release/bun-wasm}"
start_test_server() {
  [[ -n "$server_pid" ]] && return 0
  bun "$root/tests/servers/http.ts" >"$scratch/server.port" 2>"$scratch/server.err" &
  server_pid=$!
  for _ in $(seq 50); do
    [[ -s "$scratch/server.port" ]] && break
    sleep 0.1
  done
  TEST_SERVER="http://127.0.0.1:$(head -1 "$scratch/server.port")"
  export TEST_SERVER
}
if [[ $build == 1 && $update == 0 && $engine != browser ]]; then
  (cd "$root" && cargo build -j "${JOBS:-12}" --release -p bunwasm-host >"$scratch/host-build.log" 2>&1) ||
    { tail -30 "$scratch/host-build.log"; echo "launcher build failed"; exit 1; }
  "$root/scripts/build-bash-web-shell.sh" >"$scratch/shell-build.log" 2>&1 ||
    { tail -30 "$scratch/shell-build.log"; echo "bash-web shell build failed"; exit 1; }
fi
# Package scripts, Bun.$ and bun exec run in bash-web's shell at /bin/sh and /bin/bash.
shell_wasm="${BUN_WASM_SHELL:-$root/dist/bash-web-shell.wasm}"
env_wasm="${BUN_WASM_ENV_UTILITY:-$root/dist/bash-web-env.wasm}"
if [[ $update == 0 && $engine != browser && ! ( -f "$shell_wasm" && -f "$env_wasm" ) ]]; then
  echo "missing $shell_wasm or $env_wasm; run scripts/build-bash-web-shell.sh"
  exit 1
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

native_bun=""
[[ $update == 0 ]] || native_bun="$(bun -p process.execPath)"

pass=0
fail=0
failed=()
for name in "${names[@]}"; do
  if [[ $update == 0 && "$name" == http-response-lifecycle ]]; then
    if BUN_WASM_LAUNCHER="$launcher" bun "$root/scripts/http-response-lifecycle.ts" "$engine" "$scratch/http-response-lifecycle"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      failed+=("$name")
    fi
    continue
  fi
  if [[ $update == 0 && "$name" == worker-review ]]; then
    if node "$root/tests/check-worker-regressions.ts" --engine "$engine" --wasm "$wasm"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      failed+=("$name")
    fi
    continue
  fi
  if [[ $update == 0 && "$name" == fs-empty-read ]]; then
    if python3 "$root/tests/test-empty-stdin.py" --engine "$engine" --wasm "$wasm"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      failed+=("$name")
    fi
    continue
  fi
  if [[ $update == 0 && "$name" == fs-writev-partial ]]; then
    if python3 "$root/tests/test-writev-partial.py" --engine "$engine" --wasm "$wasm"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      failed+=("$name")
    fi
    continue
  fi
  if [[ $update == 0 && "$name" == pipe-closed-output ]]; then
    pipe_hosts=(node)
    [[ $engine != browser ]] && pipe_hosts=(native node)
    pipe_ok=1
    for pipe_host in "${pipe_hosts[@]}"; do
      python3 "$root/tests/test-closed-output.py" --engine "$engine" --wasm "$wasm" --host "$pipe_host" || pipe_ok=0
    done
    if [[ $pipe_ok == 1 ]]; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      failed+=("$name")
    fi
    continue
  fi
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
  is_host=0
  if [[ -f "$work/host" ]]; then
    is_host=1
    start_test_server
  fi
  if [[ $update == 1 ]]; then
    native_cmd=("${cmd[@]}")
    [[ ! -f "$work/cmd" ]] && native_cmd=(run "./$entry")
    (cd "$work" && AGENT=0 CLAUDECODE= HOME=/ "$native_bun" "${native_cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>"$scratch/err")
    code=$?
    if [[ "$code" != "$expected_exit" ]]; then
      echo "native Bun failed $name (exit $code, expected $expected_exit)"
      cat "$scratch/err"
      exit 1
    fi
    show_files "$work" "$scratch/out"
    # Native runs live in the scratch dir; inside wasm the fixture is `/`.
    sed -e "s#$work/#/#g" -e "s#$work#/#g" "$scratch/out" | normalize >"$src/expected.txt"
    if [[ -f "$src/expected_stderr.txt" ]]; then
      sed -e "s#$work/#/#g" -e "s#$work#/#g" "$scratch/err" | normalize >"$src/expected_stderr.txt"
    fi
    echo "updated $name"
    continue
  fi

  if [[ $engine == browser ]]; then
    net_flag=()
    [[ $is_host == 1 ]] && net_flag=(--net)
    gc_flags=()
    [[ ! -f "$src/expose-gc" ]] || gc_flags=(--expose-gc)
    (cd "$work" && timeout 60 node "${gc_flags[@]}" --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$wasm" --context "$context" "${net_flag[@]}" --dir "$work::/" \
      --env PWD=/ --env HOME=/ --env BUNWASM_TEST=1 --env BUNWASM_TEST_HOST=node --env "TEST_SERVER=${TEST_SERVER:-}" -- \
      "${cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>"$scratch/err")
  else
    (cd "$work" && timeout 60 "$launcher" --wasm "$wasm" --engine "$engine=$wasm" --shell "$shell_wasm" --env-utility "$env_wasm" --env "PATH=/opt/bun/$engine/bin:/bin:/usr/bin" --dir "$work::/" --env PWD=/ --env HOME=/ \
      --env BUNWASM_TEST=1 --env BUNWASM_TEST_HOST=native --env "TEST_SERVER=${TEST_SERVER:-}" -- \
      "${cmd[@]}" "${args[@]}" <"$stdin_file" >"$scratch/out" 2>"$scratch/err")
  fi
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
