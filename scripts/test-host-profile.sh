#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
scratch="$(mktemp -d /work/tmp/bun-wasm-host-profile-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
cargo build -j "${JOBS:-8}" --release --target wasm32-wasip1 -p bunwasm-cli \
  --no-default-features --features engine-host,bun-build
wasm="$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
printf 'export const answer = 42;\n' > "$scratch/dependency.mjs"
node --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$wasm" \
  --dir "$scratch::/" --env PWD=/ -- -e 'console.log(42)' > "$scratch/eval.out"
printf '42\n' > "$scratch/expected.txt"
diff -u "$scratch/expected.txt" "$scratch/eval.out"
cat > "$scratch/entry.ts" <<'JS'
import { answer } from './dependency.mjs';
const obj = { import(value: number) { return value; } };
const name: string = './dependency.mjs';
console.log(obj.import((await import(name)).answer) + answer - 42);
JS
node --no-warnings "$root/web/scripts/node-host.mjs" --wasm "$wasm" \
  --dir "$scratch::/" --env PWD=/ -- run /entry.ts > "$scratch/module.out"
diff -u "$scratch/expected.txt" "$scratch/module.out"
echo 'host-only profile: eval and TypeScript static/dynamic imports pass'
