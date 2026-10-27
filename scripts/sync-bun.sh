#!/usr/bin/env bash
# Recreate vendor/bun: oven-sh/bun at the pinned commit, its cargo path deps
# (lol-html, rust-argon2), the configure-time codegen, and our patch series.
# Safe to re-run: an existing checkout only gets missing pieces filled in.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
BUN_COMMIT=9510e74152073d850a18758ca41114d8f214ffa6
bun_dir=$root/vendor/bun
source_only=0
check_only=0
new_checkout=0
sync_args=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-only) source_only=1; shift ;;
    --check) check_only=1; shift ;;
    --bun-dir) bun_dir=${2:?--bun-dir requires a path}; shift 2 ;;
    *) echo "usage: $0 [--source-only|--check] [--bun-dir PATH]" >&2; exit 2 ;;
  esac
done

# A linked worktree has a .git file, not a directory. Never replace an existing
# directory that is not a Git checkout, or discard source changes during sync.
if [[ ! -e "$bun_dir/.git" ]]; then
  if [[ "$check_only" == 1 ]]; then
    echo "error: missing vendor/bun checkout; run scripts/sync-bun.sh" >&2
    exit 1
  fi
  if [[ -e "$bun_dir" ]]; then
    echo "error: $bun_dir exists but is not a Git checkout" >&2
    exit 1
  fi
  git clone --filter=blob:none https://github.com/oven-sh/bun.git "$bun_dir"
  git -C "$bun_dir" checkout -b wasm "$BUN_COMMIT"
  new_checkout=1
fi
if [[ -n "$(git -C "$bun_dir" status --porcelain --untracked-files=normal)" ]]; then
  echo "error: $bun_dir has local changes; refusing to synchronize" >&2
  exit 1
fi

# Derive the desired tree from the checked-in patch bytes, not the name of a
# possibly stale shared branch. Use a private index so this cannot affect the
# checkout's staged files. Most worktrees can reuse the already-patched wasm ref.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/bun-wasm-source-sync-XXXXXX")
cleanup() {
  if [[ -e "$scratch/patched/.git" ]]; then
    git -C "$bun_dir" worktree remove --force "$scratch/patched"
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
shopt -s nullglob
patches=("$root"/patches/bun/*.patch)
if [[ "$new_checkout" == 1 && ${#patches[@]} -gt 0 ]]; then
  git -C "$bun_dir" am "${patches[@]}"
fi
GIT_INDEX_FILE="$scratch/index" git -C "$bun_dir" read-tree "$BUN_COMMIT"
for patch in "${patches[@]}"; do
  GIT_INDEX_FILE="$scratch/index" git -C "$bun_dir" apply --cached --whitespace=nowarn "$patch"
done
desired=$(GIT_INDEX_FILE="$scratch/index" git -C "$bun_dir" write-tree)
current=$(git -C "$bun_dir" rev-parse 'HEAD^{tree}')
if [[ "$check_only" == 1 ]]; then
  if [[ "$current" != "$desired" ]]; then
    echo "error: vendor/bun differs from the checked-in patch series; run scripts/sync-bun.sh" >&2
    exit 1
  fi
  echo "vendor/bun source verified at $(git -C "$bun_dir" rev-parse HEAD) (tree $current)"
  exit 0
fi
if [[ "$current" != "$desired" ]]; then
  if [[ "$(git -C "$bun_dir" rev-parse --verify 'wasm^{tree}' 2>/dev/null || true)" == "$desired" ]]; then
    target=$(git -C "$bun_dir" rev-parse wasm)
  else
    # Rebuild the imported patch history without resetting a branch another
    # worktree may own. Only this disposable checkout can be removed on failure.
    git -C "$bun_dir" worktree add --detach "$scratch/patched" "$BUN_COMMIT"
    if [[ ${#patches[@]} -gt 0 ]]; then
      git -C "$scratch/patched" am "${patches[@]}"
    fi
    target=$(git -C "$scratch/patched" rev-parse HEAD)
    git -C "$bun_dir" update-ref refs/bun-wasm/patched "$target"
  fi
  git -C "$bun_dir" checkout --detach "$target"
fi
cleanup
trap - EXIT INT TERM
if [[ "$source_only" == 1 ]]; then
  echo "vendor/bun source ready at $(git -C "$bun_dir" rev-parse --short HEAD)"
  exit 0
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

# Rust's build options and byte-class tables need only Bun's compiler-free codegen
# configure, not the full native toolchain, SDK downloads, or host linker configuration.
if [ ! -f "$bun_dir/build/debug/codegen/build_options.rs" ]; then
  (cd "$bun_dir" && bun install --silent && BUN_DEBUG_QUIET_LOGS=1 bun scripts/build.ts --mode=codegen --profile=debug --buildDir=build/debug --configure-only)
  for generated in build_options.rs json_byte_class.rs xml_byte_class.rs; do
    test -f "$bun_dir/build/debug/codegen/$generated"
  done
fi
echo "vendor/bun ready at $(git -C "$bun_dir" rev-parse --short HEAD)"
