#!/usr/bin/env bash
# Shallow, blobless checkout of Hermes at the pinned commit, with hermes-wasi.patch applied.
# Idempotent: an existing checkout at the right commit is re-patched only if the patch is missing.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ ! -e "$HERMES_DIR/.git" ]]; then
  git init -q "$HERMES_DIR"
  git -C "$HERMES_DIR" remote add origin https://github.com/facebook/hermes.git
fi
if [[ "$(git -C "$HERMES_DIR" rev-parse HEAD 2>/dev/null)" != "$HERMES_COMMIT" ]]; then
  git -C "$HERMES_DIR" fetch -q --depth 1 --filter=blob:none origin "$HERMES_COMMIT"
  git -C "$HERMES_DIR" checkout -q --detach "$HERMES_COMMIT"
fi
if git -C "$HERMES_DIR" apply --check "$HERMES_SRC/hermes-wasi.patch" 2>/dev/null; then
  git -C "$HERMES_DIR" apply "$HERMES_SRC/hermes-wasi.patch"
  echo "hermes: applied hermes-wasi.patch"
elif git -C "$HERMES_DIR" apply --reverse --check "$HERMES_SRC/hermes-wasi.patch" 2>/dev/null; then
  echo "hermes: patch already applied"
else
  echo "hermes: hermes-wasi.patch neither applies nor is applied; reset $HERMES_DIR" >&2
  exit 1
fi
