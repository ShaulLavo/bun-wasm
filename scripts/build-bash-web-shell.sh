#!/usr/bin/env bash
# Build bash-web's shell guest (shell-runtime.wasm, the guest bash-web's own build:shell:browser
# ships as shell-engine.wasm) and its env utility at the pinned commit, with this repository's
# toolchain and patched WASI sysroot. bash-web publishes no prebuilt guests, so this is their only
# producer here: the native launcher runs them (--shell dist/bash-web-shell.wasm --env-utility
# dist/bash-web-env.wasm) and the web and sandbox builds ship them (scripts/browser-build.ts), checked
# against dist/bash-web-guests.json. Build paths are remapped and symbol names stripped, so the bytes
# do not depend on where CARGO_TARGET_DIR is.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=/dev/null
source "$root/env.sh"
commit=6dd5852d1926bc3b701859d644104519154f4da5
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
  -C "link-arg=--sysroot=$BUN_WASM_SYSROOT" -C link-arg=-Wl,--max-memory=268435456
  "--remap-path-prefix=$source_dir=/bash-web" "--remap-path-prefix=$CARGO_HOME=/cargo"
  # Cargo hashes a path dependency's absolute path into LLVM's symbol suffixes, so the name section
  # would differ per checkout location; the guests ship without it.
  -C strip=symbols)
toolchain=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$root/rust-toolchain.toml")
target="$CARGO_TARGET_DIR/bash-web-shell"
(cd "$source_dir" && RUSTUP_TOOLCHAIN="$toolchain" CARGO_TARGET_DIR="$target" \
  CARGO_ENCODED_RUSTFLAGS="$(IFS=$'\x1f'; echo "${flags[*]}")" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS= \
  cargo build --locked --release --target wasm32-wasip1 --manifest-path shell/Cargo.toml \
  -j "${JOBS:-2}" -p shell-engine --bin shell-runtime -p shell-utilities --bin env)
mkdir -p "$root/dist"
cp "$target/wasm32-wasip1/release/shell-runtime.wasm" "$root/dist/bash-web-shell.wasm"
cp "$target/wasm32-wasip1/release/env.wasm" "$root/dist/bash-web-env.wasm"
bun "$root/scripts/bash-web-guests.ts" write "$root/dist" "$commit" "$toolchain"
