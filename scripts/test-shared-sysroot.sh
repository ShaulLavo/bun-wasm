#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
: "${BUN_WASM_SHARED_SYSROOT:?Set the private shared sysroot}"
: "${WASI_SDK_PATH:?Source env.sh first}"
output=${1:?Usage: test-shared-sysroot.sh NEW_PROOF_DIRECTORY}
[[ ! -e "$output" && ! -L "$output" ]]
mkdir -p "$output"
# A failed proof remains evidence for the caller. No build processes survive timeout.
"$WASI_SDK_PATH/bin/clang" --target=wasm32-wasip1 --sysroot="$BUN_WASM_SHARED_SYSROOT" \
  -nostdlib -O2 -fPIC -matomics -mbulk-memory -mmutable-globals \
  -mthread-model single -fno-builtin-malloc -fno-builtin-free -c "$root/tests/fixtures/shared-sysroot/member.c" -o "$output/member.o"
"$WASI_SDK_PATH/bin/wasm-ld" -pie --experimental-pic --import-memory --shared-memory \
  --max-memory=268435456 --no-entry --export-dynamic --import-table \
  --export=__wasm_call_ctors \
  -L "$BUN_WASM_SHARED_SYSROOT/lib/wasm32-wasip1" "$output/member.o" -lc \
  --Map="$output/member.map" -o "$output/member.wasm"
rg --quiet 'libc\.a\(dlmalloc\.c\.obj\):\(dlmalloc\)' "$output/member.map"
rg --quiet 'libc\.a\(sbrk\.c\.obj\):\(sbrk\)' "$output/member.map"
sha256sum "$BUN_WASM_SHARED_SYSROOT/lib/wasm32-wasip1/libc.a" "$output/member.wasm" > "$output/digests.txt"
wasm-tools print "$output/member.wasm" > "$output/member.wat"
timeout --kill-after=2s 90s node "$root/scripts/shared-sysroot-proof.ts" "$output/member.wasm"
node "$root/scripts/shared-sysroot-proof.ts" "$output/member.wasm" "$output/member.wast"
timeout --kill-after=2s 90s wasmtime wast "$output/member.wast"
printf '{"pass":true,"host":"wasmtime-wast","members":2,"allocator":"dlmalloc","delayedWaiterMs":250}\n'
