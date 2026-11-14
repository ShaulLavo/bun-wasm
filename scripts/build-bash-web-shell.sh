#!/usr/bin/env bash
# Build the pinned bash-web shell against the consumer-owned patched WASI sysroot.
# env comes from the matching published Waffle base family. The receipt binds the
# staged bytes; browser and native launchers use the same shell/env pair.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=/dev/null
source "$root/env.sh"
commit=dad2088a8a79146336bfecff6e3cea625a47232d
source_dir="${BASH_WEB_SOURCE:-$CARGO_TARGET_DIR/bash-web-source}"
if [[ "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null)" != "$commit" ]]; then
  if [[ -n "${BASH_WEB_SOURCE:-}" ]]; then
    echo "Provided bash-web source does not match pinned commit $commit: $source_dir" >&2
    exit 1
  fi
  rm -rf "$source_dir"
  git init -q "$source_dir"
  git -C "$source_dir" fetch -q --depth 1 https://github.com/ShaulLavo/bash-web.git "$commit"
  git -C "$source_dir" checkout -q FETCH_HEAD
fi
bun "$root/scripts/build-wasi-sysroot.ts"
clang="$WASI_SDK_PATH/bin/clang"
flags=(-C link-self-contained=no -C linker-flavor=gcc -C "linker=$clang" -C link-arg=--target=wasm32-wasip1
  -C "link-arg=--sysroot=$BUN_WASM_SYSROOT" -C link-arg=-Wl,--max-memory=268435456
  "--remap-path-prefix=$source_dir=/bash-web" "--remap-path-prefix=$CARGO_HOME=/cargo"
  # Keep names until the strict verifier has inspected libc and filesystem imports.
  -C strip=debuginfo)
toolchain=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$root/rust-toolchain.toml")
target="$CARGO_TARGET_DIR/bash-web-shell"
(cd "$source_dir" && RUSTUP_TOOLCHAIN="$toolchain" CARGO_TARGET_DIR="$target" \
  CARGO_ENCODED_RUSTFLAGS="$(IFS=$'\x1f'; echo "${flags[*]}")" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS= \
  cargo build --locked --release --target wasm32-wasip1 --manifest-path shell/Cargo.toml \
  -j "${JOBS:-2}" -p shell-engine --bin shell-runtime)
mkdir -p "$root/dist"
guest="$target/wasm32-wasip1/release/shell-runtime.wasm"
(cd "$root" && bun --eval 'import { verifyWasiGuest } from "waffle/program-build-tools"; verifyWasiGuest(process.argv[1], { filesystemAdapter: "waffle_program_support::runtime::wasi" });' "$guest")
# LLVM symbol suffixes carry build paths. Ship the verified guest without custom sections.
wasm-tools strip --all "$guest" -o "$root/dist/bash-web-shell.wasm"
bun "$root/scripts/bash-web-guests.ts" stage-env "$root" "$root/dist"
bun "$root/scripts/bash-web-guests.ts" write "$root/dist" "$commit" "$toolchain"
