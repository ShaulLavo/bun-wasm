#!/usr/bin/env bash
set -euo pipefail

normalize() {
  jq -S '
    def pins:
      with_entries(
        if (.value | type) == "string" and (
          (.value | test("^(github:ShaulLavo/(tree-sitter-x|tree-sitter-md)#|git\\+https://github.com/ShaulLavo/(bash-web|waffle)\\.git#|https://github.com/ShaulLavo/(waffle|bash-web|ghostty-webgpu|singapore|hotkeys|fregat|bubli)/releases/download/|https://registry\\.npmjs\\.org/bash-web/-/bash-web-[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz$|npm:@waffle-os/runtime@[0-9]+\\.[0-9]+\\.[0-9]+$)"))
          or ((.key == "@waffle-os/runtime" or .key == "@waffle-os/relay") and (.value | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")))
        )
        then .value = "<owned-package-pin>" else . end);
    def section($name): if has($name) then .[$name] |= pins else . end;
    section("dependencies") | section("devDependencies") | section("peerDependencies") |
    section("optionalDependencies") | section("overrides") |
    if (.workspaces | type) == "object" and (.workspaces | has("catalog")) then .workspaces.catalog |= pins else . end |
    if has("allowScripts") then .allowScripts |= with_entries(
      if (.key | test("^waffle@[0-9]+\\.[0-9]+\\.[0-9]+$")) then .key = "waffle@<pin>" else . end)
    else . end
  '
}

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/manifest-validation-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
while IFS= read -r -d '' file; do
  [[ "$file" == package.json || "$file" == */package.json ]] || continue
  git show "HEAD:$file" | normalize > "$scratch/before"
  normalize < "$file" > "$scratch/after"
  if ! cmp -s "$scratch/before" "$scratch/after"; then
    echo "::error::Dependency update changed manifest fields beyond version pins: $file" >&2
    exit 1
  fi
done < <(git diff --name-only -z HEAD)

if ! git diff --quiet -- scripts/build-bash-web-shell.sh; then
  git show HEAD:scripts/build-bash-web-shell.sh | sed -E 's/^commit=[0-9a-f]{40}$/commit=<pin>/' > "$scratch/before"
  sed -E 's/^commit=[0-9a-f]{40}$/commit=<pin>/' scripts/build-bash-web-shell.sh > "$scratch/after"
  cmp "$scratch/before" "$scratch/after"
fi

if [[ -f scripts/bash-web-release-inputs.json ]] && ! git diff --quiet -- scripts/bash-web-release-inputs.json; then
  if ! jq -e '
    (keys | sort == ["bytes", "sha256", "sourceCommit", "url", "version"])
    and (.url | type == "string" and test("^https://registry\\.npmjs\\.org/bash-web/-/bash-web-[0-9]+\\.[0-9]+\\.[0-9]+\\.tgz$"))
    and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
    and (.sourceCommit | type == "string" and test("^[0-9a-f]{40}$"))
    and (.version | type == "string" and test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
    and (.bytes | type == "number" and . > 0 and . == floor)
  ' scripts/bash-web-release-inputs.json > /dev/null; then
    echo "::error::Invalid scripts/bash-web-release-inputs.json record shape" >&2
    exit 1
  fi
fi
