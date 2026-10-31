#!/usr/bin/env bash
# First Hermes proof on the native launcher (G2, G3):
#   tests/hermes/run.sh LAUNCHER CORE
# CORE is a bun-hermes.wasm with hermes-engine.wasm beside it.
set -euo pipefail
launcher=${1:?usage: tests/hermes/run.sh LAUNCHER CORE}
core=${2:?usage: tests/hermes/run.sh LAUNCHER CORE}
root=$(cd "$(dirname "$0")/../.." && pwd)
launcher=$(realpath "$launcher")
core=$(realpath "$core")
cd "$root"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/bun-wasm-hermes-proof-XXXXXX")
server=''
cleanup() {
  if [[ -n "$server" ]]; then kill -KILL "$server" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

run() { "$launcher" --wasm "$core" -- "$@"; }

# expect NAME EXPECTED-STDOUT bun-arguments...: exit 0, exact stdout, empty stderr.
expect() {
  local name=$1 expected=$2
  shift 2
  local status=0
  run "$@" >"$scratch/out" 2>"$scratch/err" || status=$?
  if [[ $status != 0 || "$(cat "$scratch/out")" != "$expected" || -s "$scratch/err" ]]; then
    echo "FAIL $name (exit $status)"
    echo "--- stdout"; cat "$scratch/out"
    echo "--- stderr"; cat "$scratch/err"
    exit 1
  fi
  echo "ok   $name"
}

expect eval "2" -e 'console.log(1 + 1)'
expect hello "hello 2" run tests/hermes/hello.cts
expect jest-worker-require "jest-worker module-relative require and teardown ok" run tests/hermes/jest-worker-require.cts
expect nft-require "nft module-relative require ok" run tests/hermes/nft-require.cts
expect serve-self "200 hello from /hermes" run tests/hermes/serve.cts

# The host fetches a guest server, then asks it to raise SIGINT on itself (guest signal path).
port=$(bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop(true)')
"$launcher" --wasm "$core" --env "PORT=$port" -- run tests/hermes/serve-hold.cts >"$scratch/hold.out" 2>"$scratch/hold.err" &
server=$!
for _ in $(seq 600); do
  grep -q '^listening' "$scratch/hold.out" && break
  kill -0 "$server" 2>/dev/null || break
  sleep 0.1
done
body=$(curl -fsS --max-time 10 "http://127.0.0.1:$port/from-host") || body="(fetch failed)"
stop=$(curl -fsS --max-time 10 "http://127.0.0.1:$port/stop") || stop="(fetch failed)"
status=0
for _ in $(seq 300); do
  kill -0 "$server" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$server" 2>/dev/null; then
  status=timeout # the EXIT trap kills it
else
  wait "$server" || status=$?
  server=''
fi
if [[ "$body" != "hermes GET /from-host" || "$stop" != "hermes GET /stop" || $status != 0 || "$(cat "$scratch/hold.out")" != "$(printf 'listening %s\nstopping' "$port")" ]]; then
  echo "FAIL serve-host (exit $status, body: $body, stop: $stop)"
  echo "--- stdout"; cat "$scratch/hold.out"
  echo "--- stderr"; cat "$scratch/hold.err"
  exit 1
fi
echo "ok   serve-host"
