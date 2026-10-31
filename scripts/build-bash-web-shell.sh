#!/usr/bin/env bash
# Build the pinned bash-web shell against the consumer-owned patched WASI sysroot.
# env comes from the matching published Waffle base family. The receipt binds the
# staged bytes; browser and native launchers use the same shell/env pair.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=/dev/null
source "$root/env.sh"
commit=e9275ce50e266a521b06521c51a12776ee6fbddf
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
  # The name section carries LLVM symbol suffixes derived from those paths; the guests ship without it.
  -C strip=symbols)
toolchain=$(sed -n 's/^channel = "\(.*\)"/\1/p' "$root/rust-toolchain.toml")
target="$CARGO_TARGET_DIR/bash-web-shell"
(cd "$source_dir" && RUSTUP_TOOLCHAIN="$toolchain" CARGO_TARGET_DIR="$target" \
  CARGO_ENCODED_RUSTFLAGS="$(IFS=$'\x1f'; echo "${flags[*]}")" CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS= \
  cargo build --locked --release --target wasm32-wasip1 --manifest-path shell/Cargo.toml \
  -j "${JOBS:-2}" -p shell-engine --bin shell-runtime)
mkdir -p "$root/dist"
cp "$target/wasm32-wasip1/release/shell-runtime.wasm" "$root/dist/bash-web-shell.wasm"
cp "$root/node_modules/waffle-coreutils/dist/env.wasm" "$root/dist/bash-web-env.wasm"
bun "$root/scripts/bash-web-guests.ts" write "$root/dist" "$commit" "$toolchain"
