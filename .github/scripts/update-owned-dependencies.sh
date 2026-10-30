#!/usr/bin/env bash
set -euo pipefail

files=(package.json web/package.json sandbox/package.json)

latest_release_tag() {
  local repository=$1
  local prefix=$2
  gh api "repos/${repository}/releases?per_page=100" --paginate \
    --jq ".[] | select(.draft == false and .prerelease == false) | select(.tag_name | startswith(\"${prefix}\")) | .tag_name" |
    sed -n '1p'
}

update_git_pins() {
  local repository=$1
  local revision
  revision=$(git ls-remote "https://github.com/${repository}.git" HEAD | awk '{print $1}')
  test "$revision" != ""
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    sed -E -i \
      "s|git\+https://github.com/${repository}\.git#[0-9a-f]{40}|git+https://github.com/${repository}.git#${revision}|g; s|github:${repository}#[0-9a-f]{7,40}|github:${repository}#${revision:0:7}|g" \
      "$file"
  done
}

update_release_pins() {
  local repository=$1
  local release_prefix=$2
  local tag version
  tag=$(latest_release_tag "$repository" "$release_prefix")
  [[ -n "$tag" ]] || return 0
  version=${tag#"${release_prefix}"}
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    if [[ "$release_prefix" == 'waffle-v' ]]; then
      sed -E -i \
        "s|waffle-v[0-9]+\.[0-9]+\.[0-9]+/waffle-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${tag}/waffle-${version}.tgz|g" \
        "$file"
      continue
    fi
    sed -E -i \
      "s|programs-v[0-9]+\.[0-9]+\.[0-9]+/waffle-([[:alnum:]-]+)-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${tag}/waffle-\1-${version}.tgz|g" \
      "$file"
  done
}

update_git_pins ShaulLavo/bash-web
bash_revision=$(jq -r '.dependencies["bash-web"] | split("#")[1]' web/package.json)
[[ "$bash_revision" =~ ^[0-9a-f]{40}$ ]]
sed -E -i "s/^commit=[0-9a-f]{40}$/commit=${bash_revision}/" scripts/build-bash-web-shell.sh
update_release_pins ShaulLavo/waffle waffle-v
update_release_pins ShaulLavo/waffle programs-v

bash .github/scripts/update-waffle-records.sh

bun install --lockfile-only --ignore-scripts
bun install --cwd web --lockfile-only --ignore-scripts
bun install --cwd sandbox --lockfile-only --ignore-scripts
