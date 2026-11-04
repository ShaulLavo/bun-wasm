#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/waffle-records-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
record=scripts/waffle-release-inputs.json
runtime_url=$(jq -r '.devDependencies.waffle' package.json)
version=$(printf '%s' "$runtime_url" | sed -E 's|.*/waffle-v([0-9.]+)/.*|\1|')
revision=$(git ls-remote https://github.com/ShaulLavo/waffle.git "refs/tags/waffle-v${version}^{}" "refs/tags/waffle-v${version}" | tail -n 1 | cut -f1)
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]
curl -fsSL --max-time 120 "$runtime_url" -o "$scratch/runtime.tgz"
jq --arg url "$runtime_url" --arg version "$version" --arg revision "$revision" \
  --arg sha256 "$(sha256sum "$scratch/runtime.tgz" | cut -d ' ' -f1)" \
  --argjson bytes "$(wc -c < "$scratch/runtime.tgz")" \
  '.url = $url | .sha256 = $sha256 | .bytes = $bytes | .version = $version | .sourceCommit = $revision' \
  "$record" > "$scratch/record.json"
for file in package.json scripts/build-wasi-libc.sh patches/wasi-libc/preopen-scan.patch; do
  curl -fsSL --max-time 120 "https://raw.githubusercontent.com/ShaulLavo/waffle/${revision}/packages/waffle/${file}" -o "$scratch/input"
  jq --arg path "$file" --arg hash "$(sha256sum "$scratch/input" | cut -d ' ' -f1)" \
    '.files[$path] = $hash' "$scratch/record.json" > "$scratch/next.json"
  mv "$scratch/next.json" "$scratch/record.json"
done
base_url=$(jq -r '.peerDependencies["waffle-base"]' package.json)
program_tag=$(printf '%s' "$base_url" | cut -d/ -f8)
manifest_url="https://github.com/ShaulLavo/waffle/releases/download/${program_tag}/program-release.json"
curl -fsSL --max-time 120 "$manifest_url" -o "$scratch/programs.json"
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
  else {schema, toolCommit: tool_commit} end
  | if .toolCommit | type == "string" and test("^[0-9a-f]{40}$") then . else error("Program release tool commit is not a full revision") end
' "$scratch/programs.json")
base=$(jq -ce --arg url "$base_url" '[.packages[] | select(.name == "waffle-base" and .url == $url)] | if length == 1 then .[0] else error("Missing base release") end' "$scratch/programs.json")
curl -fsSL --max-time 120 "$base_url" -o "$scratch/base.tgz"
test "$(sha256sum "$scratch/base.tgz" | cut -d ' ' -f1)" = "$(jq -r '.sha256' <<< "$base")"
jq --arg tag "$program_tag" --arg commit "$(jq -er '.sourceCommit' "$scratch/programs.json")" \
  --arg url "$manifest_url" --arg hash "$(sha256sum "$scratch/programs.json" | cut -d ' ' -f1)" \
  --argjson bytes "$(wc -c < "$scratch/programs.json")" --argjson base "$base" --argjson identity "$identity" \
  '.programs = {tag: $tag, sourceCommit: $commit, manifest: {url: $url, bytes: $bytes, sha256: $hash},
    base: ($base | {url, bytes, sha256, sourceDirectory, sourceTree, version})} + $identity' \
  "$scratch/record.json" > "$scratch/next.json"
# A failed update leaves the record untouched; copying in place keeps its file mode.
cat "$scratch/next.json" > "$record"
