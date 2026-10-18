#!/usr/bin/env bash
# Sparse, blobless checkout of Bun's WebKit fork at the pinned commit, with webkit-wasi.patch applied.
# Idempotent: an existing checkout at the right commit is re-patched only if the patch is missing.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

paths=(Source/JavaScriptCore Source/WTF Source/bmalloc Source/cmake Source/ThirdParty/unifdef
  Source/ThirdParty/xdgmime Tools/Scripts Tools/cmake)

if [[ ! -e "$WEBKIT_DIR/.git" ]]; then
  git init -q "$WEBKIT_DIR"
  git -C "$WEBKIT_DIR" remote add origin https://github.com/oven-sh/WebKit.git
  git -C "$WEBKIT_DIR" config remote.origin.promisor true
  git -C "$WEBKIT_DIR" config remote.origin.partialclonefilter blob:none
  git -C "$WEBKIT_DIR" sparse-checkout set "${paths[@]}"
fi
if [[ "$(git -C "$WEBKIT_DIR" rev-parse HEAD 2>/dev/null)" != "$WEBKIT_COMMIT" ]]; then
  git -C "$WEBKIT_DIR" fetch -q --depth 1 --filter=blob:none origin "$WEBKIT_COMMIT"
  git -C "$WEBKIT_DIR" checkout -q --detach "$WEBKIT_COMMIT"
fi
if git -C "$WEBKIT_DIR" apply --check "$JSC_SRC/webkit-wasi.patch" 2>/dev/null; then
  git -C "$WEBKIT_DIR" apply "$JSC_SRC/webkit-wasi.patch"
  echo "webkit: applied webkit-wasi.patch"
elif git -C "$WEBKIT_DIR" apply --reverse --check "$JSC_SRC/webkit-wasi.patch" 2>/dev/null; then
  echo "webkit: patch already applied"
else
  echo "webkit: webkit-wasi.patch neither applies nor is applied; reset $WEBKIT_DIR" >&2
  exit 1
fi
