#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/share/mise/shims:$PATH
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
engine="${1:?usage: measure-web-workers.sh quickjs|jsc|browser output.json}"
output="${2:?output.json required}"
launcher="$CARGO_TARGET_DIR/release/bun-wasm"
case "$engine" in
  quickjs) wasm="$root/dist/bun.wasm" ;;
  jsc) wasm="$root/dist/bun-jsc.wasm" ;;
  browser) wasm="$root/dist/bun-browser.wasm" ;;
  *) echo "unknown engine: $engine" >&2; exit 2 ;;
esac
if [[ "$engine" != browser ]]; then timeout 180 "$launcher" --wasm "$wasm" -e 0 >/dev/null; fi
exec "$root/scripts/bun-suite.sh" --engine "$engine" --launcher "$launcher" \
  --dependencies "${BUN_SUITE_DEPENDENCIES:-$root/docs/bun-test-suite/dependencies/node_modules}" \
  --network loopback --jobs 1 --timeout 15 --output "$output" --log-dir "${output%.json}-logs" \
  js/bun/util/bun-isMainThread.test.js \
  js/third_party/comlink/comlink.test.ts \
  js/web/broadcastchannel/broadcast-channel-worker-gc.test.ts \
  js/web/broadcastchannel/broadcast-channel.test.ts \
  js/web/structured-clone-shared-array-buffer.test.ts \
  js/web/timers/timer-heap-race.test.ts \
  js/web/workers/message-port-context-destroy-leak.test.ts \
  js/web/workers/worker-entry-point.test.ts \
  js/web/workers/worker-terminate-lifetime.test.ts \
  js/web/workers/worker.test.ts \
  js/web/workers/worker_blob.test.ts
