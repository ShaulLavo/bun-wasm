#!/usr/bin/env bash
# Publish the playground as a private Mesh app. The app runs web/serve.ts so the
# page gets COOP/COEP (cross-origin isolation, Atomics.wait sleeps); `mesh app
# update` must be given the same --run/--port again or the app turns static.
#   scripts/publish-web.sh            create a new app
#   scripts/publish-web.sh <app-id>   update an existing one
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
stage=${STAGE_DIR:-/work/apps/bun-wasm-playground}
(cd "$root/web" && bun run build)
rm -rf "$stage" && mkdir -p "$stage"
cp "$root/web/serve.ts" "$stage/"
cp -r "$root/web/dist" "$stage/dist" && rm -f "$stage"/dist/*.map
server=(--run 'bun serve.ts' --port 4173 --env PORT=4173 --env HOST=127.0.0.1 --json)
if [ $# -gt 0 ]; then
  mesh app update pc "$1" "$stage" "${server[@]}"
else
  mesh app create pc "$stage" "${server[@]}"
fi
