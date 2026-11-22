#!/usr/bin/env bash
set -euo pipefail

files=(package.json web/package.json sandbox/package.json)

# The releases API orders by tag creation date, which is not the version order when a
# release reuses an older tagged commit. Pick the highest version instead.
latest_release_tag() {
  local repository=$1
  local prefix=$2
  gh api "repos/${repository}/releases?per_page=100" --paginate \
    --jq ".[] | select(.draft == false and .prerelease == false) | select(.tag_name | startswith(\"${prefix}\")) | .tag_name" |
    sort -V | sed -n '$p'
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
    if [[ "$release_prefix" == 'bash-web-v' ]]; then
      sed -E -i \
        "s|bash-web-v[0-9]+\.[0-9]+\.[0-9]+/bash-web-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${tag}/bash-web-${version}.tgz|g" \
        "$file"
      continue
    fi
    sed -E -i \
      "s|programs-v[0-9]+\.[0-9]+\.[0-9]+/waffle-([[:alnum:]-]+)-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${tag}/waffle-\1-${version}.tgz|g" \
      "$file"
  done
}

update_waffle_npm_pins() {
  local runtime relay file
  runtime=$(npm view --registry=https://registry.npmjs.org/ @waffle-os/runtime dist-tags.latest)
  relay=$(npm view --registry=https://registry.npmjs.org/ @waffle-os/relay dist-tags.latest)
  [[ "$runtime" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$relay" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  for file in "${files[@]}"; do
    sed -E -i \
      -e "s|(\"@waffle-os/runtime\": \")[0-9]+\.[0-9]+\.[0-9]+\"|\1${runtime}\"|g" \
      -e "s|(\"waffle\": \"npm:@waffle-os/runtime@)[0-9]+\.[0-9]+\.[0-9]+\"|\1${runtime}\"|g" \
      -e "s|(\"@waffle-os/relay\": \")[0-9]+\.[0-9]+\.[0-9]+\"|\1${relay}\"|g" \
      "$file"
  done
}

# The web app pins a bash-web release tarball; the shell guest builds from that release's commit.
update_release_pins ShaulLavo/bash-web bash-web-v
bash_tag=$(jq -r '.devDependencies["bash-web"] // .dependencies["bash-web"] // ""' web/package.json |
  sed -nE 's|^https://github\.com/ShaulLavo/bash-web/releases/download/(bash-web-v[0-9]+\.[0-9]+\.[0-9]+)/.*$|\1|p')
if [[ -z "$bash_tag" ]]; then
  echo 'error: web/package.json does not pin a bash-web release tarball.' >&2
  exit 1
fi
bash_revision=$(gh api "repos/ShaulLavo/bash-web/commits/${bash_tag}" --jq .sha)
if [[ ! "$bash_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "error: could not resolve the commit of bash-web release ${bash_tag}." >&2
  exit 1
fi
sed -E -i "s/^commit=[0-9a-f]{40}$/commit=${bash_revision}/" scripts/build-bash-web-shell.sh
update_waffle_npm_pins
update_release_pins ShaulLavo/waffle programs-v

bash .github/scripts/update-waffle-records.sh

bun scripts/ci-update-lock.ts .
bun scripts/ci-update-lock.ts web
bun scripts/ci-update-lock.ts sandbox
