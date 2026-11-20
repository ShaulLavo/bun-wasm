#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
cd "$root"
: "${SPIDERMONKEY_NATIVE_DIR:?Set the verified SpiderMonkey native input directory}"
export CARGO_TARGET_DIR=${SPIDERMONKEY_CONTROLS_TARGET_DIR:-$root/target/spidermonkey-controls}
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS="-C relocation-model=pic -C panic=abort -C link-self-contained=no -L native=$BUN_WASM_SYSROOT/lib/wasm32-wasip1"
export CFLAGS_wasm32_wasip1="--sysroot=$BUN_WASM_SYSROOT -fPIC"
export CXXFLAGS_wasm32_wasip1="--sysroot=$BUN_WASM_SYSROOT -fPIC -fno-exceptions"
cargo build --locked --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j 4 \
  -p bunwasm-spidermonkey --features controls --example engine-semantics
wasm="$CARGO_TARGET_DIR/wasm32-wasip1/release/examples/engine-semantics.wasm"
for tier in interp pbl; do
  for mode in ordinary fault-terminate heap-sync heap-pending recovery recovery-terminate; do
    args=(--env "BUN_WASM_SPIDERMONKEY_TIER=$tier")
    if [[ "$mode" != ordinary ]]; then
      args+=(--env "BUNSM_CONTROL_MODE=$mode")
    fi
    timeout 360s wasmtime run -W max-wasm-stack=16777216 "${args[@]}" "$wasm"
  done
  # F16: a failed module-map insertion keeps the adapter's trap-on-exhaustion policy.
  if trap=$(timeout 360s wasmtime run -W max-wasm-stack=16777216 --env "BUN_WASM_SPIDERMONKEY_TIER=$tier" \
    --env BUNSM_CONTROL_MODE=recovery-map-trap "$wasm" 2>&1); then
    echo "F16 map insertion fault did not trap on $tier" >&2
    exit 1
  fi
  grep -q 'fatal module map allocation failure' <<<"$trap" || { echo "$trap" >&2; exit 1; }
  echo "SpiderMonkey map insertion trap control passed"
done
