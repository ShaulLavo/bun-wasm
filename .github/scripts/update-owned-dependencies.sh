#!/usr/bin/env bash
set -euo pipefail

files=(package.json web/package.json sandbox/package.json)
npm_registry="${NPM_REGISTRY:-https://registry.npmjs.org}"
bash_web_git_url="${BASH_WEB_GIT_URL:-https://github.com/ShaulLavo/bash-web.git}"

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
    sed -E -i \
      "s|programs-v[0-9]+\.[0-9]+\.[0-9]+/waffle-([[:alnum:]-]+)-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${tag}/waffle-\1-${version}.tgz|g" \
      "$file"
  done
}

update_bash_web_npm_pins() {
  local version tag tags revision url integrity sha256 bytes scratch file record_stage
  scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/bash-web-update-XXXXXX")
  trap 'rm -rf -- "$scratch"' RETURN

  version=$(npm view --registry=https://registry.npmjs.org/ bash-web dist-tags.latest)
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "error: invalid npm version for bash-web: ${version}" >&2
    return 1
  }
  tag="refs/tags/bash-web@${version}"
  url="${npm_registry}/bash-web/-/bash-web-${version}.tgz"
  local expected_tarball="https://registry.npmjs.org/bash-web/-/bash-web-${version}.tgz"

  curl -fsSL --max-time 120 "${npm_registry}/bash-web/${version}" -o "$scratch/bash-web-npm.json"
  tags=$(git ls-remote "$bash_web_git_url" "$tag" "$tag^{}")
  revision=$(awk -v t="$tag" '$2 == t { plain = $1 } $2 == t "^{}" { peeled = $1 } END { print (peeled ? peeled : plain) }' <<< "$tags")
  if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
    echo "error: missing canonical source tag ${tag}" >&2
    return 1
  fi

  if ! integrity=$(jq -er --arg version "$version" --arg revision "$revision" --arg url "$expected_tarball" --arg alt "$url" '
    select(.name == "bash-web" and .version == $version and .gitHead == $revision and (.dist.tarball == $url or .dist.tarball == $alt))
    | .dist.integrity | select(test("^sha512-[A-Za-z0-9+/]+={0,2}$"))
  ' "$scratch/bash-web-npm.json"); then
    echo "error: npm registry metadata does not match canonical tag ${tag} (${revision})" >&2
    return 1
  fi

  curl -fsSL --max-time 120 "$url" -o "$scratch/bash-web.tgz"
  if [[ "$(openssl dgst -sha512 -binary "$scratch/bash-web.tgz" | openssl base64 -A)" != "${integrity#sha512-}" ]]; then
    echo "error: npm registry integrity mismatch for bash-web@${version}" >&2
    return 1
  fi

  sha256=$(sha256sum "$scratch/bash-web.tgz" | cut -d ' ' -f1)
  bytes=$(wc -c < "$scratch/bash-web.tgz")

  for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    sed -E -i \
      -e "s|https://github\.com/ShaulLavo/bash-web/releases/download/bash-web-v[0-9]+\.[0-9]+\.[0-9]+/bash-web-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${expected_tarball}|g" \
      -e "s|https://registry\.npmjs\.org/bash-web/-/bash-web-[0-9]+\.[0-9]+\.[0-9]+\.tgz|${expected_tarball}|g" \
      "$file"
  done

  if [[ -f scripts/bash-web-release-inputs.json ]]; then
    record_stage=$(mktemp "scripts/bash-web-release-inputs.json.stage.XXXXXX")
    jq -n \
      --arg url "$expected_tarball" \
      --arg sha256 "$sha256" \
      --argjson bytes "$bytes" \
      --arg version "$version" \
      --arg sourceCommit "$revision" \
      '{url: $url, sha256: $sha256, bytes: $bytes, version: $version, sourceCommit: $sourceCommit}' \
      > "$record_stage"
    mv -fT -- "$record_stage" scripts/bash-web-release-inputs.json
  fi

  if [[ -f scripts/build-bash-web-shell.sh ]]; then
    sed -E -i "s/^commit=[0-9a-f]{40}$/commit=${revision}/" scripts/build-bash-web-shell.sh
  fi
}

update_waffle_npm_pins() {
  local runtime relay file
  runtime=$(npm view --registry=https://registry.npmjs.org/ @waffle-os/runtime dist-tags.latest)
  relay=$(npm view --registry=https://registry.npmjs.org/ @waffle-os/relay dist-tags.latest)
  [[ "$runtime" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$relay" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
  for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    sed -E -i \
      -e "s|(\"@waffle-os/runtime\": \")[0-9]+\.[0-9]+\.[0-9]+\"|\1${runtime}\"|g" \
      -e "s|(\"waffle\": \"npm:@waffle-os/runtime@)[0-9]+\.[0-9]+\.[0-9]+\"|\1${runtime}\"|g" \
      -e "s|(\"@waffle-os/relay\": \")[0-9]+\.[0-9]+\.[0-9]+\"|\1${relay}\"|g" \
      "$file"
  done
}

update_bash_web_npm_pins
update_waffle_npm_pins
update_release_pins ShaulLavo/waffle programs-v

bash .github/scripts/update-waffle-records.sh

bun scripts/ci-update-lock.ts .
bun scripts/ci-update-lock.ts web
bun scripts/ci-update-lock.ts sandbox
