#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/waffle-records-XXXXXX")
record_stage=
cleanup() {
  if [[ -n "$record_stage" ]]; then rm -f -- "$record_stage"; fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
record=scripts/waffle-release-inputs.json
host_interface=$(jq -er '.waffleHostInterface | select(type == "number" and . > 0 and . == floor and . <= 9007199254740991)' package.json)
require_interface() {
  if ! jq -e --argjson expected "$host_interface" '.waffleHostInterface == $expected' "$1" > /dev/null; then
    echo "$2 host interface does not match the consumer" >&2
    exit 1
  fi
}
runtime_url=$(jq -r '.devDependencies.waffle' package.json)
version=$(printf '%s' "$runtime_url" | sed -E 's|.*/waffle-v([0-9.]+)/.*|\1|')
[[ "$runtime_url" == "https://github.com/ShaulLavo/waffle/releases/download/waffle-v${version}/waffle-${version}.tgz" ]] || { echo 'Runtime pin is not a canonical Waffle release' >&2; exit 1; }
revision=$(git ls-remote https://github.com/ShaulLavo/waffle.git "refs/tags/waffle-v${version}^{}" "refs/tags/waffle-v${version}" | tail -n 1 | cut -f1)
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
bun scripts/ci-release-download.ts "$runtime_url" "$scratch/runtime.tgz" 120000
tar -xOf "$scratch/runtime.tgz" package/package.json > "$scratch/runtime-package.json"
require_interface "$scratch/runtime-package.json" Runtime
jq -e --arg version "$version" '.name == "waffle" and .version == $version' "$scratch/runtime-package.json" > /dev/null
jq --arg url "$runtime_url" --arg version "$version" --arg revision "$revision" \
  --arg sha256 "$(sha256sum "$scratch/runtime.tgz" | cut -d ' ' -f1)" \
  --argjson bytes "$(wc -c < "$scratch/runtime.tgz")" --argjson interface "$host_interface" \
  '.hostInterface = $interface | .url = $url | .sha256 = $sha256 | .bytes = $bytes | .version = $version | .sourceCommit = $revision' \
  "$record" > "$scratch/record.json"
for file in package.json scripts/build-wasi-libc.sh patches/wasi-libc/preopen-scan.patch; do
  curl -fsSL --max-time 120 "https://raw.githubusercontent.com/ShaulLavo/waffle/${revision}/packages/waffle/${file}" -o "$scratch/input"
  tar -xOf "$scratch/runtime.tgz" "package/$file" > "$scratch/packaged-input"
  if ! cmp -s "$scratch/input" "$scratch/packaged-input"; then
    echo "Runtime archive differs from its tagged source: $file" >&2
    exit 1
  fi
  jq --arg path "$file" --arg hash "$(sha256sum "$scratch/input" | cut -d ' ' -f1)" \
    '.files[$path] = $hash' "$scratch/record.json" > "$scratch/next.json"
  mv "$scratch/next.json" "$scratch/record.json"
done
relay_url=$(jq -er '.peerDependencies["waffle-relay"]' package.json)
relay_version=$(printf '%s' "$relay_url" | sed -E 's|.*/waffle-v([0-9.]+)/.*|\1|')
[[ "$relay_url" == "https://github.com/ShaulLavo/waffle/releases/download/waffle-v${relay_version}/waffle-relay-${relay_version}.tgz" ]]
relay_revision=$(git ls-remote https://github.com/ShaulLavo/waffle.git "refs/tags/waffle-v${relay_version}^{}" "refs/tags/waffle-v${relay_version}" | tail -n 1 | cut -f1)
[[ "$relay_revision" =~ ^[0-9a-f]{40}$ ]]
bun scripts/ci-release-download.ts "$relay_url" "$scratch/relay.tgz" 120000
tar -xOf "$scratch/relay.tgz" package/package.json > "$scratch/relay-package.json"
require_interface "$scratch/relay-package.json" Relay
jq -e --arg version "$relay_version" '.name == "waffle-relay" and .version == $version and .peerDependencies.waffle == "*" and .dependencies.waffle == null' "$scratch/relay-package.json" > /dev/null
jq --arg url "$relay_url" --arg version "$relay_version" --arg revision "$relay_revision" \
  --arg hash "$(sha256sum "$scratch/relay.tgz" | cut -d ' ' -f1)" \
  --argjson bytes "$(wc -c < "$scratch/relay.tgz")" --argjson interface "$host_interface" \
  '.relay = {url: $url, version: $version, sourceCommit: $revision, sha256: $hash, bytes: $bytes, hostInterface: $interface}' \
  "$scratch/record.json" > "$scratch/next.json"
mv "$scratch/next.json" "$scratch/record.json"
base_url=$(jq -r '.peerDependencies["waffle-base"]' package.json)
program_tag=$(printf '%s' "$base_url" | cut -d/ -f8)
manifest_url="https://github.com/ShaulLavo/waffle/releases/download/${program_tag}/program-release.json"
bun scripts/ci-release-download.ts "$manifest_url" "$scratch/programs.json" 120000
# The record keeps the release schema and the commit of the tools that packed it. A normal release
# is packed by the tools at its own source commit; a peer rebind names its separate tool commit.
identity=$(jq -ce --arg tag "$program_tag" '
  def tool_commit:
    if .operation == "release" then .sourceCommit
    elif .operation != "peer-rebind" then error("Unsupported program release operation: \(.operation)")
    elif .rebind.toolDirty != false then error("Program rebind tools were not clean")
    else .rebind.toolCommit end;
  if .schema != "waffle-program-release/2" then error("Unsupported program release schema: \(.schema)")
  elif .tag != $tag then error("Program release manifest names \(.tag), not \($tag)")
  elif .dirty != false or .tagState != "tagged" then error("Program release was not packed from its clean tag")
  elif (.sourceCommit | type == "string" and test("^[0-9a-f]{40}$") | not) then error("The original program source commit is not a full revision")
  else {schema, toolCommit: tool_commit} end
  | if .toolCommit | type == "string" and test("^[0-9a-f]{40}$") then . else error("Program release tool commit is not a full revision") end
' "$scratch/programs.json")
if ! jq -e --argjson expected "$host_interface" '.runtime.waffleHostInterface == $expected and (.packages | type == "array" and all(.waffleHostInterface == $expected))' "$scratch/programs.json" > /dev/null; then
  echo "Program family host interface does not match the consumer" >&2
  exit 1
fi
base=$(jq -ce --arg url "$base_url" '[.packages[] | select(.name == "waffle-base" and .url == $url)] | if length == 1 then .[0] else error("Missing base release") end' "$scratch/programs.json")
if ! jq -e '
  def revision: type == "string" and test("^[0-9a-f]{40}$");
  def source_path: type == "string" and length > 0 and (startswith("/") | not)
    and (contains("\\") | not) and (contains("\u0000") | not)
    and (split("/") | all(. != "" and . != "." and . != ".."));
  (.sourceTree | revision) and (.sourceDirectory | source_path)
' <<< "$base" > /dev/null; then
  echo 'Base source directory or tree is invalid' >&2
  exit 1
fi
bun scripts/ci-release-download.ts "$base_url" "$scratch/base.tgz" 120000
test "$(sha256sum "$scratch/base.tgz" | cut -d ' ' -f1)" = "$(jq -r '.sha256' <<< "$base")"
test "$(wc -c < "$scratch/base.tgz")" = "$(jq -r '.bytes' <<< "$base")"
tar -xOf "$scratch/base.tgz" package/package.json > "$scratch/base-package.json"
require_interface "$scratch/base-package.json" Base
jq -e --arg version "$(jq -er '.version' <<< "$base")" '.name == "waffle-base" and .version == $version' "$scratch/base-package.json" > /dev/null
jq --arg tag "$program_tag" --arg commit "$(jq -er '.sourceCommit' "$scratch/programs.json")" \
  --arg url "$manifest_url" --arg hash "$(sha256sum "$scratch/programs.json" | cut -d ' ' -f1)" \
  --argjson bytes "$(wc -c < "$scratch/programs.json")" --argjson base "$base" --argjson identity "$identity" \
  '.programs = {tag: $tag, sourceCommit: $commit, manifest: {url: $url, bytes: $bytes, sha256: $hash},
    base: ($base | {url, bytes, sha256, sourceDirectory, sourceTree, version})} + $identity' \
  "$scratch/record.json" > "$scratch/next.json"
# Stage beside the record so the final rename stays on its filesystem.
record_stage=$(mktemp "${record}.stage.XXXXXX")
chmod --reference="$record" "$record_stage"
cat "$scratch/next.json" > "$record_stage"
mv -fT -- "$record_stage" "$record"
record_stage=
