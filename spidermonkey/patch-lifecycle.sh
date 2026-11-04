#!/usr/bin/env bash

spidermonkey_patch_prepare() {
  local source=$1 patch=$2
  if git -C "$source" apply --check "$patch" 2>/dev/null; then
    git -C "$source" apply "$patch" || return
    printf 'applied\n'
    return
  fi
  if git -C "$source" apply --reverse --check "$patch" 2>/dev/null; then
    printf 'present\n'
    return
  fi
  printf 'spidermonkey: patch neither applies nor is already applied\n' >&2
  return 1
}

spidermonkey_patch_restore() {
  [[ "$1" == applied ]] || return 0
  git -C "$2" apply --reverse "$3"
}
