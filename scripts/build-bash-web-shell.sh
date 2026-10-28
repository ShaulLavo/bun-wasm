#!/usr/bin/env bash
# Build bash-web's shell guest (shell-runtime.wasm) and its env utility for the native launcher's
# package-script fixtures: bunwasm-host --shell dist/bash-web-shell.wasm --env-utility
# dist/bash-web-env.wasm. The browser gets both from the bash-web package instead. Uses this repository's toolchain and patched WASI sysroot.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=/dev/null
source "$root/env.sh"
commit=15e749fe16a85c15be293dfc5312de47d282bed8
source_dir="${BASH_WEB_SOURCE:-$CARGO_TARGET_DIR/bash-web-source}"
if [[ "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null)" != "$commit" ]]; then
  rm -rf "$source_dir"
  git init -q "$source_dir"
  git -C "$source_dir" fetch -q --depth 1 https://github.com/ShaulLavo/bash-web.git "$commit"
  git -C "$source_dir" checkout -q FETCH_HEAD
fi
bun "$root/scripts/build-wasi-sysroot.ts"
clang="$WASI_SDK_PATH/bin/clang"
flags=(-C link-self-contained=no -C linker-flavor=gcc -C "linker=$clang" -C link-arg=--target=wasm32-wasip1
  -C "link-arg=--sysroot=$BUN_WASM_SYSROOT" -C link-arg=-Wl,--max-memory=268435456)
toolchain=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$root/rust-toolchain.toml")
target="$CARGO_TARGET_DIR/bash-web-shell"
(cd "$source_dir" && RUSTUP_TOOLCHAIN="$toolchain" CARGO_TARGET_DIR="$target" \
  CARGO_ENCODED_RUSTFLAGS="$(IFS=$'\x1f'; echo "${flags[*]}")" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS= \
  cargo build --locked --release --target wasm32-wasip1 --manifest-path shell/Cargo.toml \
  -j "${JOBS:-2}" -p shell-engine --bin shell-runtime -p shell-utilities --bin env)
mkdir -p "$root/dist"
cp "$target/wasm32-wasip1/release/shell-runtime.wasm" "$root/dist/bash-web-shell.wasm"
cp "$target/wasm32-wasip1/release/env.wasm" "$root/dist/bash-web-env.wasm"
for guest in shell env; do
  printf 'dist/bash-web-%s.wasm: %s bytes (bash-web %s)\n' "$guest" "$(stat -c %s "$root/dist/bash-web-$guest.wasm")" "$commit"
done
