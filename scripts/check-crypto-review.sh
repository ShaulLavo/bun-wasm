#!/bin/bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$PATH
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
launcher="${BUN_WASM_LAUNCHER:-$CARGO_TARGET_DIR/release/bun-wasm}"
report=${1:?report directory required}
mkdir -p "$report"
scratch=$(mktemp -d /work/tmp/bun-wasm-crypto-review-units-XXXXXX)
trap 'rm -rf "$scratch"' EXIT INT TERM
fixtures=(crypto-vectors crypto-native-aes192 crypto-hmac-required-hash crypto-hmac-derived-hash crypto-sha1-jwk crypto-p384-sha1 crypto-native-provider crypto-native-lifetime)
if [[ ${2:-} == --node ]]; then fixtures+=(crypto-keyobject-derivation crypto-rsa-padding crypto-native-node-interop node-crypto-keys); fi
failed=0
for engine in quickjs jsc browser; do
 for fixture in "${fixtures[@]}"; do
  work="$scratch/$engine-$fixture"
  cp -r "$root/tests/fixtures/$fixture" "$work"
  case $engine in
   quickjs) command=("$launcher" --wasm "$root/dist/bun.wasm" --dir "$work::/" --env PWD=/ -- run /index.js);;
   jsc) command=("$launcher" --wasm "$root/dist/bun-jsc.wasm" --dir "$work::/" --env PWD=/ -- run /index.js);;
   browser) command=(node --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$root/dist/bun-browser.wasm" --dir "$work::/" -- run /index.js);;
  esac
  if "${command[@]}" > "$report/$engine-$fixture.log" 2>&1 && diff -u "$root/tests/fixtures/$fixture/expected.txt" "$report/$engine-$fixture.log" > "$report/$engine-$fixture.diff"; then
   echo "PASS $engine $fixture"
   if [[ -f "$work/produced.json" ]]; then
    cp "$work/produced.json" "$report/$engine-$fixture-produced.json"
    for native in node bun; do
     if ! "$native" "$root/scripts/crypto-review-vectors.mjs" "$fixture" "$work/produced.json" >> "$report/$engine-$fixture-native-verify.log" 2>&1; then failed=1; fi
    done
   fi
  else
   echo "FAIL $engine $fixture"
   tail -8 "$report/$engine-$fixture.log"
   failed=1
  fi
 done
done
exit "$failed"
