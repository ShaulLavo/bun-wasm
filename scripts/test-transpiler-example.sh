#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/env.sh"
cd "$root"
scratch="$(mktemp -d /work/tmp/bun-wasm-transpiler-example-XXXXXX)"
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT TERM
cargo build -j "${JOBS:-8}" --release --target wasm32-wasip1 -p bunwasm-transpiler --examples
example="$CARGO_TARGET_DIR/wasm32-wasip1/release/examples/transpile.wasm"
printf 'const answer: number = 42;\nconsole.log(answer);\n' > "$scratch/input.ts"
wasmtime run --dir "$scratch::/" "$example" /input.ts > "$scratch/output.js"
node "$scratch/output.js" > "$scratch/output.txt"
printf '42\n' > "$scratch/expected.txt"
diff -u "$scratch/expected.txt" "$scratch/output.txt"
wasmtime run --dir "$scratch::/" "$example" --map /input.ts > "$scratch/map.json"
node --input-type=module - "$scratch/map.json" <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const map = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(map.version, 3);
assert.ok(map.mappings.length > 0);
assert.ok(map.sourcesContent[0].includes(': number'));
JS
echo 'transpiler examples: compile, generated code and source map pass'
