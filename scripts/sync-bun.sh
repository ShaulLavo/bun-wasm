#!/usr/bin/env bash
# Recreate vendor/bun: oven-sh/bun at the pinned commit, its cargo path deps
# (lol-html, rust-argon2), the configure-time codegen, and our patch series.
# Safe to re-run: an existing checkout moves to the pinned commit, and its dependencies and
# generated files are refreshed only when what they were made from changed.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/env.sh"
BUN_COMMIT=a7733435cf40429e3b35c36072769df2052b80f1
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
  git clone --filter=blob:none --depth=1 --no-tags --revision="$BUN_COMMIT" https://github.com/oven-sh/bun.git "$bun_dir"
  git -C "$bun_dir" checkout -b wasm "$BUN_COMMIT"
  new_checkout=1
fi
if [[ -n "$(git -C "$bun_dir" status --porcelain --untracked-files=normal)" ]]; then
  echo "error: $bun_dir has local changes; refusing to synchronize" >&2
  exit 1
fi
# An existing shallow checkout holds only the pin it was cloned at. The explicit check keeps
# a partial clone from fetching the bare commit object on demand.
if ! GIT_NO_LAZY_FETCH=1 git -C "$bun_dir" cat-file -e "$BUN_COMMIT^{commit}" 2>/dev/null; then
  if [[ "$check_only" == 1 ]]; then
    echo "error: vendor/bun does not have the pinned commit $BUN_COMMIT; run scripts/sync-bun.sh" >&2
    exit 1
  fi
  git -C "$bun_dir" fetch --filter=blob:none --depth=1 --no-tags origin "$BUN_COMMIT"
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
# Importing a patch needs a committer even in a clean CI checkout. Keep the
# identity local to this command; git am still reads each patch's author.
apply_source_patches() {
  # Bun's codegen embeds HEAD in Rust source, so the patch commits must repeat.
  git -C "$1" -c user.name="bun-wasm source sync" -c user.email="source-sync@bun-wasm.invalid" \
    am --committer-date-is-author-date "${patches[@]}"
}
if [[ "$new_checkout" == 1 && ${#patches[@]} -gt 0 ]]; then
  apply_source_patches "$bun_dir"
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
      apply_source_patches "$scratch/patched"
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

# A vendored dependency is unpacked again when Bun pins another commit for it or changes
# its patches, so a checkout that moves to a new Bun pin does not keep the old dependency.
# Bun's .gitignore covers vendor/, so the local-changes check above cannot see work there.
# A tree is replaced only when its content is known: what this script last put there, or
# the pinned archive with none, some or all of its patches (a tree from before the markers).
staging=""
trap '[[ -z "$staging" ]] || rm -rf "$staging"' EXIT
trap 'exit 130' INT TERM
# One digest over a tree: the type, mode and path of every entry, the content of every
# file and the target of every link. The C locale keeps the order the same everywhere.
tree_digest() { # <dir>
  (
    export LC_ALL=C
    cd "$1"
    find . -mindepth 1 -printf '%y %m %P\n' | sort
    find . -type f -print0 | sort -z | xargs -0 -r sha256sum
    find . -type l -printf '%P -> %l\n' | sort
  ) | sha256sum | cut -d' ' -f1
}
refuse_dependency() { # <path>
  echo "error: $1 has content this script did not put there, and git does not track it; refusing to replace it" >&2
  echo "save what you need from it, remove it (rm -rf $1) and run scripts/sync-bun.sh again" >&2
  exit 1
}
fetch() { # <dir> <repo> <commit> [patch, relative to vendor/bun]...
  local name=$1 repo=$2 commit=$3
  shift 3
  local dir=$bun_dir/vendor/$name stamp=$bun_dir/vendor/.bun-wasm-$name.source
  # Where a known old tree goes before it is removed. Only this script puts a tree there,
  # so what an interrupted run left behind is removed here.
  local old=$bun_dir/vendor/.bun-wasm-$name.old
  local want file current="" recorded="" stage known=0
  want=$(
    printf '%s\n' "$commit"
    for file in "$@"; do
      printf '%s %s\n' "$(sha256sum < "$bun_dir/$file" | cut -d' ' -f1)" "$file"
    done
  )
  rm -rf "$old"
  if [[ -L "$dir" || ( -e "$dir" && ! -d "$dir" ) ]]; then
    refuse_dependency "$dir"
  fi
  if [[ -d "$dir" && -n "$(ls -A "$dir")" ]]; then
    current=$(tree_digest "$dir")
    recorded=$(sed -n 's/^tree //p' "$stamp" 2>/dev/null || true)
  fi
  if [[ -n "$current" && "$current" == "$recorded" ]]; then
    known=1
    if [[ "$(grep -v '^tree ' "$stamp")" == "$want" ]]; then
      return
    fi
  fi
  # Unpack and patch beside the tree, and move the result in only once it is complete.
  mkdir -p "$bun_dir/vendor"
  staging=$(mktemp -d "$bun_dir/vendor/.bun-wasm-$name.XXXXXX")
  mkdir "$staging/tree"
  curl -fsSL "https://github.com/$repo/archive/$commit.tar.gz" | tar xz --strip-components=1 -C "$staging/tree"
  local -a stages=("$(tree_digest "$staging/tree")")
  for file in "$@"; do
    patch -d "$staging/tree" -p1 < "$bun_dir/$file"
    stages+=("$(tree_digest "$staging/tree")")
  done
  # The tree is already the one wanted: a run was interrupted before it wrote the marker,
  # or the marker is gone. Keep the tree.
  if [[ "$current" == "${stages[-1]}" ]]; then
    printf '%s\ntree %s\n' "$want" "$current" > "$stamp"
    rm -rf "$staging"
    staging=""
    return
  fi
  if [[ -z "$recorded" ]]; then
    for stage in "${stages[@]}"; do
      [[ "$stage" != "$current" ]] || known=1
    done
  fi
  if [[ -n "$current" && "$known" == 0 ]]; then
    refuse_dependency "$dir"
  fi
  # An interrupted removal then leaves only the .old directory, never half of the tree.
  if [[ -n "$current" ]]; then
    mv "$dir" "$old"
  elif [[ -d "$dir" ]]; then
    rmdir "$dir"
  fi
  mv "$staging/tree" "$dir"
  printf '%s\ntree %s\n' "$want" "${stages[-1]}" > "$stamp"
  rm -rf "$staging" "$old"
  staging=""
}
lolhtml=$(grep -oP 'LOLHTML_COMMIT = "\K[0-9a-f]+' "$bun_dir/scripts/build/deps/lolhtml.ts")
argon2=$(grep -oP 'RUST_ARGON2_COMMIT = "\K[0-9a-f]+' "$bun_dir/scripts/build/deps/rust-argon2.ts")
# The patches Bun lists for the dependency, in its order.
mapfile -t argon2_patches < <(grep -oP '"\Kpatches/rust-argon2/[^"]+\.patch' "$bun_dir/scripts/build/deps/rust-argon2.ts")
fetch lolhtml oven-sh/lol-html "$lolhtml"
fetch rust-argon2 sru-systems/rust-argon2 "$argon2" "${argon2_patches[@]}"

# Rust's build options and byte-class tables need only Bun's compiler-free codegen
# configure, not the full native toolchain, SDK downloads, or host linker configuration.
# The output holds Bun's version and commit, so it is generated again for every new
# vendor/bun commit. Bun pins the commit of a local debug build in git-revision at the
# first configure; removing the pin lets it read the current one.
codegen=$bun_dir/build/debug/codegen
codegen_stamp=$bun_dir/build/debug/.bun-wasm-codegen
head=$(git -C "$bun_dir" rev-parse HEAD)
if [[ ! -f "$codegen/build_options.rs" || "$(cat "$codegen_stamp" 2>/dev/null)" != "$head" ]]; then
  rm -f "$bun_dir/build/debug/git-revision"
  (cd "$bun_dir" && bun install --silent && BUN_DEBUG_QUIET_LOGS=1 bun scripts/build.ts --mode=codegen --profile=debug --buildDir=build/debug --configure-only)
  for generated in build_options.rs json_byte_class.rs xml_byte_class.rs; do
    test -f "$codegen/$generated"
  done
  printf '%s\n' "$head" > "$codegen_stamp"
fi
echo "vendor/bun ready at $(git -C "$bun_dir" rev-parse --short HEAD)"
