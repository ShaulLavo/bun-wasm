#!/usr/bin/env bash
# Recreate vendor/bun: oven-sh/bun at the pinned commit, its cargo path deps
# (lol-html, rust-argon2), the configure-time codegen, and our patch series.
# Safe to re-run: an existing checkout only gets missing pieces filled in.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
BUN_COMMIT=9510e74152073d850a18758ca41114d8f214ffa6
bun_dir=$root/vendor/bun

if [ ! -d "$bun_dir/.git" ]; then
  git clone --filter=blob:none https://github.com/oven-sh/bun.git "$bun_dir"
  git -C "$bun_dir" checkout -b wasm "$BUN_COMMIT"
  if ls "$root"/patches/bun/*.patch >/dev/null 2>&1; then
    git -C "$bun_dir" am "$root"/patches/bun/*.patch
  fi
fi

fetch() { # <dir> <repo> <commit>
  [ -f "$bun_dir/vendor/$1/Cargo.toml" ] && return
  mkdir -p "$bun_dir/vendor/$1"
  curl -fsSL "https://github.com/$2/archive/$3.tar.gz" | tar xz --strip-components=1 -C "$bun_dir/vendor/$1"
}
lolhtml=$(grep -oP 'LOLHTML_COMMIT = "\K[0-9a-f]+' "$bun_dir/scripts/build/deps/lolhtml.ts")
argon2=$(grep -oP 'RUST_ARGON2_COMMIT = "\K[0-9a-f]+' "$bun_dir/scripts/build/deps/rust-argon2.ts")
fetch lolhtml oven-sh/lol-html "$lolhtml"
if [ ! -f "$bun_dir/vendor/rust-argon2/Cargo.toml" ]; then
  fetch rust-argon2 sru-systems/rust-argon2 "$argon2"
  patch -d "$bun_dir/vendor/rust-argon2" -p1 < "$bun_dir/patches/rust-argon2/legacy-low-memory.patch"
fi

# build_options.rs + byte-class tables. Bun's configure stops at a missing nasm
# (BoringSSL), after these are written; that is all the toolchain crates need.
# It also prunes vendor/, so the fetches above run again afterwards.
if [ ! -f "$bun_dir/build/debug/codegen/build_options.rs" ]; then
  (cd "$bun_dir" && bun install --silent && BUN_DEBUG_QUIET_LOGS=1 bun scripts/build.ts --profile=debug --configure-only || true)
  test -f "$bun_dir/build/debug/codegen/build_options.rs"
  # Configure also writes a host linker config that picks wasi-sdk's clang++ off PATH.
  rm -f "$bun_dir/.cargo/config.toml"
  exec "$0"
fi
echo "vendor/bun ready at $(git -C "$bun_dir" rev-parse --short HEAD)"
