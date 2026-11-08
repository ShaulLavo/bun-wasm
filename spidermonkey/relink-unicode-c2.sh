#!/usr/bin/env bash
# C2 only: reconstruct the retained early side's source, then add the Unicode
# glue and complete adapter. No mach build, profile change, or engine execution.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo"
source env.sh
: "${SPIDERMONKEY_C2_DIR:?set a disposable C2 directory under /work/tmp}"
: "${SPIDERMONKEY_NATIVE_DIR:?set the immutable early G3 native input directory}"
: "${SPIDERMONKEY_EARLY_REPORT:?set the early G3 report with engine-execution.cpp and vm-execution.rs}"
: "${SPIDERMONKEY_MOZILLA_SOURCE:?set the immutable pinned Mozilla source}"

out=$(realpath -m "$SPIDERMONKEY_C2_DIR")
[[ "$out" == /work/tmp/bun-wasm-* ]] || { echo 'C2 output must be task-private /work/tmp/bun-wasm-*' >&2; exit 1; }
mkdir -p "$out"
trap 'jobs -pr | xargs -r kill 2>/dev/null || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
export CARGO_TARGET_DIR="$out/target"
# Same split-side Rust flags as engineEnvironment(). No retained tree changes.
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
export CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS='-C relocation-model=pic -C panic=abort -C link-self-contained=no'

CARGO_TARGET_DIR="${SPIDERMONKEY_C2_GENERATOR_TARGET:-$out/generator-target}" node spidermonkey/generate-special-case.ts --check
python3 - "$repo" "$out" "$SPIDERMONKEY_EARLY_REPORT" <<'PY'
from pathlib import Path
import sys
repo,out,early=map(Path,sys.argv[1:])
root=(repo/'crates/bunwasm-engine-spidermonkey/src/lib.rs').read_text()
root=root.replace('include!("../../bunwasm-engine-quickjs/src/side_modules.rs");',
    f'include!("{repo}/crates/bunwasm-engine-quickjs/src/side_modules.rs");')
root=root.replace('mod vm;',f'#[path = "{early}/vm-execution.rs"]\nmod vm;')
(out/'early-side.rs').write_text(root)
(out/'Cargo.toml').write_text(f'''[package]
name = "bunwasm-engine-spidermonkey"
version = "0.0.53"
edition = "2024"
[workspace]
[lib]
path = "early-side.rs"
crate-type = ["staticlib"]
[dependencies]
bunwasm-spidermonkey = {{ path = "{repo}/crates/bunwasm-spidermonkey" }}
[profile.release]
opt-level = "s"
lto = "thin"
codegen-units = 4
panic = "abort"
debug = false
''')
# Seed from the selected source lock, not a newly resolved registry graph.
if not (out/'Cargo.lock').exists(): (out/'Cargo.lock').write_bytes((repo/'Cargo.lock').read_bytes())
PY
cargo build --offline -Zbuild-std=std,panic_abort --release --target wasm32-wasip1 -j 4 --manifest-path "$out/Cargo.toml"
archive="$out/libearly-side-unicode.a"
cp "$out/target/wasm32-wasip1/release/libbunwasm_engine_spidermonkey.a" "$archive"
# Retain the actual early C++ execution source, not the later draft's diagnostic
# cleanup or a parallel worker's Engine semantics. Replace only its shim member.
git show 7c53995bddcd61dee7640eed41e0f11a71f88c8d:crates/bunwasm-spidermonkey/cpp/engine.h > "$out/engine.h"
"$CXX_wasm32_wasip1" --sysroot="$BUN_WASM_SYSROOT" -Os -ffunction-sections -fdata-sections \
  -fPIC -fno-exceptions -fno-rtti -std=c++20 -DBUNWASM_EMBED=1 \
  -include "$SPIDERMONKEY_NATIVE_DIR/js-confdefs.h" -I "$SPIDERMONKEY_NATIVE_DIR/include" \
  -I "$out" -c "$SPIDERMONKEY_EARLY_REPORT/engine-execution.cpp" -o "$out/early-engine.o"
mapfile -t shim_members < <("$WASI_SDK_PATH/bin/llvm-ar" t "$archive" | grep -E -- '-engine\.o$')
[[ "${#shim_members[@]}" == 1 ]] || { echo 'Expected one original engine shim member' >&2; exit 1; }
"$WASI_SDK_PATH/bin/llvm-ar" d "$archive" "${shim_members[0]}"
"$WASI_SDK_PATH/bin/llvm-ar" rcs "$archive" "$out/early-engine.o"

"$CC_wasm32_wasip1" --sysroot="$BUN_WASM_SYSROOT" -fPIC -O2 -fno-builtin-malloc \
  -fno-builtin-free -DENGINE_CTOR_VALUE=spidermonkey_ctor_value \
  -c scripts/src/engine-init.c -o "$out/engine-init.o"

adapter="$repo/spidermonkey/irregexp-icu"
cpp_flags=(-Os -ffunction-sections -fdata-sections -fPIC -fno-exceptions -fno-rtti -std=c++20
  --sysroot="$BUN_WASM_SYSROOT" -DBUNWASM_EMBED=1 -DMOZILLA_CLIENT -DV8_INTL_SUPPORT -DBUNWASM_IRREGEXP_ICU4X
  -include "$SPIDERMONKEY_NATIVE_DIR/js-confdefs.h" -I "$adapter/include"
  -I "$SPIDERMONKEY_MOZILLA_SOURCE/../obj/dist/include" -I "$SPIDERMONKEY_MOZILLA_SOURCE/js/src"
  -I "$SPIDERMONKEY_MOZILLA_SOURCE/../obj/js/src" -I "$SPIDERMONKEY_MOZILLA_SOURCE/../obj")
for name in allocator icu_subset probe; do
  "$CXX_wasm32_wasip1" "${cpp_flags[@]}" -MD -MF "$out/$name.d" -c "$adapter/$name.cpp" -o "$out/$name.o"
done
# Reuse the exact pinned irregexp translation-unit flags for the two support
# adapters, including MOZ_HAS_MOZGLUE and generated-header include directories.
python3 - "$SPIDERMONKEY_MOZILLA_SOURCE" "$adapter" "$out" <<'PYCODE'
import json, pathlib, shlex, subprocess, sys
source,adapter,out=map(pathlib.Path,sys.argv[1:])
commands=source.parent/'obj/clangd/compile_commands.json'
entry=next(e for e in json.loads(commands.read_text()) if e['file'].endswith('/irregexp/RegExpNativeMacroAssembler.cpp'))
args=entry['arguments'][:]
args[args.index('-o')+1]='/dev/null'
args.remove(entry['file'])
extra=['-DV8_INTL_SUPPORT','-DBUNWASM_IRREGEXP_ICU4X','-DBUNWASM_EMBED=1','-I'+str(adapter/'include')]
(out/'support-compile-template.json').write_text(json.dumps(entry,indent=2)+'\n')
for relative,name in [('util/ZoneShimFFI.cpp','ZoneShimFFI'),(str(adapter/'generated/special-case.cc'),'special-case')]:
    command=args+extra+['-MD','-MF',str(out/(name+'.d')),str(pathlib.Path(relative) if pathlib.Path(relative).is_absolute() else source/'js/src/irregexp'/relative)]
    command[command.index('-o')+1]=str(out/(name+'.o'))
    print(shlex.join(command), flush=True)
    subprocess.run(command, cwd=entry['directory'], check=True)
PYCODE

link_flags=(--shared --Bsymbolic --no-export-dynamic --gc-sections --no-entry
  --import-memory=env,memory --import-table --allow-undefined
  --export=spidermonkey_ctor_value --export=__stack_pointer --export=__wasm_call_ctors
  --export=spidermonkey_register --export=spidermonkey_run)
"$WASI_SDK_PATH/bin/wasm-ld" "${link_flags[@]}" -Map="$out/base.map" -o "$out/base.implicit.wasm" "$out/engine-init.o" "$archive"
node scripts/spidermonkey-side-core-receipt.ts convert-side "$out/base.implicit.wasm" "$out/base.wasm"

probe_exports=(bunsm_icu_probe_property bunsm_icu_probe_sets bunsm_icu_probe_aliases bunsm_icu_probe_all_properties
  bunsm_ucd_simple_fold bunsm_ucd_is_letter bunsm_ucd_property_ranges bunsm_ucd_close_over_scf
  bunsm_ucd_value_enum bunsm_ucd_is_cased bunsm_ucd_is_case_ignorable
  mozilla_properties_glue_has_property mozilla_properties_glue_add_property_ranges
  bunsm_icu_is_exact_property_alias bunsm_icu_is_exact_property_value_alias js_irregexp_add_range_to_zone_list)
# Export all adapter-owned definitions, including set operations not called by
# the old no-Intl archive. Do not export unrelated inline std/Mozilla internals
# from the support headers. Their actual consumers retain them normally.
mapfile -t adapter_exports < <("$WASI_SDK_PATH/bin/llvm-nm" --defined-only --extern-only --format=posix \
  "$out/allocator.o" "$out/icu_subset.o" "$out/probe.o" "$out/special-case.o" |   awk '$2 ~ /^[TWD]$/ && $1 ~ /^(bunsm_|bun_properties$|u_|_ZNK?3icu|_ZN2v88internal6regexp)/ {print $1}' | sort -u)
for name in "${probe_exports[@]}" "${adapter_exports[@]}"; do link_flags+=("--export=$name"); done
"$WASI_SDK_PATH/bin/wasm-ld" "${link_flags[@]}" -Map="$out/probe.map" -o "$out/probe.implicit.wasm" \
  "$out/engine-init.o" "$out/allocator.o" "$out/icu_subset.o" "$out/probe.o" \
  "$out/ZoneShimFFI.o" "$out/special-case.o" "$archive"
node scripts/spidermonkey-side-core-receipt.ts convert-side "$out/probe.implicit.wasm" "$out/probe.wasm"
printf '%s\n' "${probe_exports[@]}" "${adapter_exports[@]}" > "$out/required-exports.txt"
node spidermonkey/unicode-c2-receipt.ts "$out" "$SPIDERMONKEY_NATIVE_DIR" "$SPIDERMONKEY_EARLY_REPORT"
