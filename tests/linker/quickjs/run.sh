#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
source env.sh
# The guest memory maximum, through its validating reader before anything is linked.
max_memory=$(bun scripts/src/program-profile.ts max-memory)
out=${QUICKJS_BUILD_DIR:?Set QUICKJS_BUILD_DIR to a lane-private build directory}
node tests/linker/quickjs/check-smoke-exports.ts "$out/engine.wasm"
tests/linker/quickjs/build-ops.sh
out=$(cd "$out" && pwd)
node --input-type=module - "$out" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const out=process.argv[2];
const module=new WebAssembly.Module(readFileSync(`${out}/engine.wasm`));
const names=WebAssembly.Module.imports(module).filter(x=>x.module==='env'&&x.kind==='function'||x.module==='GOT.mem').map(x=>x.name);
writeFileSync(`${out}/core-exports.txt`,Array.from(new Set(names.concat(['_start','bun_core_alloc','bun_core_free','bun_core_dispatch','core_usable','core_clock_address','core_clock_smoke','core_errno_smoke','core_stdout_value','__stack_pointer','__stack_low','__stack_high','__heap_base','__wasm_call_ctors']))).join('\n')+'\n');
JS
args=()
while IFS= read -r name; do args+=("-Wl,--export=$name"); done < "$out/core-exports.txt"
clang --target=wasm32-wasip1 --sysroot="$BUN_WASM_SYSROOT" -O2 -nostartfiles \
  tests/linker/quickjs/core.c "$out/ops-core.a" -Wl,--no-entry -Wl,--export-table -Wl,--growable-table \
  -Wl,-z,stack-size=8388608 -Wl,--max-memory="$max_memory" "${args[@]}" -o "$out/core.wasm"
wasm-tools print "$out/engine.wasm" > "$out/engine.wat"
wasm-tools print "$out/core.wasm" > "$out/core.wat"
if grep -q 'memory.grow' "$out/engine.wat"; then echo 'engine owns memory.grow' >&2; exit 1; fi
if grep -q '(start ' "$out/engine.wat"; then echo 'engine has implicit start' >&2; exit 1; fi
node tests/linker/quickjs/smoke.ts "$out"
sha256sum "$out/engine.wasm" "$out/core.wasm" > "$out/artifact-sha256.txt"
