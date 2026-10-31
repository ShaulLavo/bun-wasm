#!/usr/bin/env bash
# Fetch a shallow, blobless SpiderMonkey checkout using make-source-package.py's
# source closure, then apply the local patch when one exists.
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ ! -d "$SPIDERMONKEY_DIR/.git" ]]; then
  git init -q "$SPIDERMONKEY_DIR"
  git -C "$SPIDERMONKEY_DIR" remote add origin https://github.com/mozilla-firefox/firefox.git
fi

if [[ "$(git -C "$SPIDERMONKEY_DIR" rev-parse HEAD 2>/dev/null || true)" != "$SPIDERMONKEY_COMMIT" ]]; then
  git -C "$SPIDERMONKEY_DIR" fetch -q --depth 1 --filter=blob:none origin "$SPIDERMONKEY_COMMIT"
  git -C "$SPIDERMONKEY_DIR" sparse-checkout init --no-cone
  filter_file="$SPIDERMONKEY_BUILD_DIR/rsync-filter.txt"
  git -C "$SPIDERMONKEY_DIR" show "$SPIDERMONKEY_COMMIT:js/src/make-source-package.py" \
    | sed -n '/^rsync_filter_list = """/,/^"""$/p' \
    | tac \
    | sed -n -E 's/^\+ \/(.*)$/\/\1/p; s/^- \/(.*)$/!\/\1/p' \
    | sed '/^!\/\*\*$/d' \
    | { cat; printf '/Cargo.toml\n/CLOBBER\n'; } \
    > "$filter_file"
  git -C "$SPIDERMONKEY_DIR" sparse-checkout set --no-cone --stdin < "$filter_file"
  git -C "$SPIDERMONKEY_DIR" checkout -q --detach "$SPIDERMONKEY_COMMIT"
fi

# Reuse the standalone manifest transformation from Mozilla's source packager.
# Cargo metadata must not walk the full browser workspace in a sparse tree.
git -C "$SPIDERMONKEY_DIR" show "$SPIDERMONKEY_COMMIT:Cargo.toml" > "$SPIDERMONKEY_DIR/Cargo.toml"
python3 - "$SPIDERMONKEY_DIR" <<'PYTHON'
import ast
import enum
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
script = root / "js/src/make-source-package.py"
module = ast.parse(script.read_text(), filename=str(script))
helpers = {"is_mozjs_cargo_member", "is_mozjs_crates_io_local_patch", "copy_cargo_toml"}
module.body = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in helpers]
assert len(module.body) == len(helpers)
context = {"enum": enum, "topsrc_dir": root, "target_dir": root}
exec(compile(module, str(script), "exec"), context)
context["copy_cargo_toml"]()
PYTHON

patch="$SPIDERMONKEY_SRC/spidermonkey-wasi.patch"
if [[ -s "$patch" ]]; then
  if git -C "$SPIDERMONKEY_DIR" apply --check "$patch" 2>/dev/null; then
    git -C "$SPIDERMONKEY_DIR" apply "$patch"
    echo "spidermonkey: applied spidermonkey-wasi.patch"
  elif git -C "$SPIDERMONKEY_DIR" apply --reverse --check "$patch" 2>/dev/null; then
    echo "spidermonkey: patch already applied"
  else
    echo "spidermonkey: patch neither applies nor is applied; reset $SPIDERMONKEY_DIR" >&2
    exit 1
  fi
else
  echo "spidermonkey: no local patch yet"
fi

git -C "$SPIDERMONKEY_DIR" rev-parse HEAD
