import { expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const updater = join(import.meta.dir, "../.github/scripts/update-owned-dependencies.sh");
const download = "https://github.com/ShaulLavo/waffle/releases/download";
const bashDownload = "https://github.com/ShaulLavo/bash-web/releases/download";
const oldBashRevision = "0".repeat(40);
const newBashRevision = "2".repeat(40);

// The releases API answers from per-repository fixtures through the caller's own jq filter.
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || { echo "unexpected gh $*" >&2; exit 2; }
path=$2
filter=.
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jq) filter=$2; shift 2 ;;
    *) shift ;;
  esac
done
case "$path" in
  repos/ShaulLavo/bash-web/commits/*) printf '{"sha":"%s"}' "${newBashRevision}" | jq -r "$filter" ;;
  repos/ShaulLavo/*/releases*) repo=\${path#repos/ShaulLavo/}; jq -r "$filter" "$FIXTURE_ROOT/\${repo%%/*}.json" ;;
  *) echo "unrouted $path" >&2; exit 2 ;;
esac
`;

const release = (tag_name: string, draft = false) => ({ tag_name, draft, prerelease: false });
const fakeNpm = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $4" == "view --registry=https://registry.npmjs.org/ dist-tags.latest" ]]
case "$3" in
  @waffle-os/runtime) echo 0.0.146 ;;
  @waffle-os/relay) echo 0.0.145 ;;
  *) exit 2 ;;
esac
`;

const releases = {
  "waffle.json": [release("waffle-v0.0.150"), release("programs-v0.0.23"), release("programs-v0.0.22")],
  "bash-web.json": [release("bash-web-v0.0.2"), release("bash-web-v0.0.1")],
};

function manifests(runtime: string, relay: string, programs: string, bash: string) {
  const waffle = `npm:@waffle-os/runtime@${runtime}`;
  const base = `${download}/programs-v${programs}/waffle-base-${programs}.tgz`;
  return {
    "package.json": { devDependencies: { "@waffle-os/runtime": runtime, waffle, "@waffle-os/relay": relay }, peerDependencies: { "waffle-base": base, "@waffle-os/relay": relay } },
    "web/package.json": { dependencies: { "@waffle-os/runtime": runtime, waffle, "waffle-base": base, "@waffle-os/relay": relay },
      devDependencies: { "bash-web": `${bashDownload}/bash-web-v${bash}/bash-web-${bash}.tgz` } },
    "sandbox/package.json": { dependencies: { waffle } },
  };
}

async function writeTree(root: string, files: Readonly<Record<string, string>>) {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), text);
  }
}

const json = (files: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(files).map(([file, value]) => [file, `${JSON.stringify(value, null, 2)}\n`]));

test("the owned dependency update reads independent npm runtime and relay pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-owned-update-"));
  try {
    const repository = join(root, "repository");
    await writeTree(repository, {
      ...json(manifests("0.0.144", "0.0.144", "0.0.22", "0.0.1")),
      "scripts/build-bash-web-shell.sh": `commit=${oldBashRevision}\n`,
      ".github/scripts/update-waffle-records.sh": "exit 0\n",
      "scripts/ci-update-lock.ts": "export {};\n",
    });
    await writeTree(root, { "bin/gh": fakeGh, "bin/npm": fakeNpm, ...json(releases) });
    await chmod(join(root, "bin/gh"), 0o755);
    await chmod(join(root, "bin/npm"), 0o755);
    const result = Bun.spawnSync(["bash", updater], {
      cwd: repository,
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FIXTURE_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    for (const [file, text] of Object.entries(json(manifests("0.0.146", "0.0.145", "0.0.23", "0.0.2"))))
      expect(await readFile(join(repository, file), "utf8")).toBe(text);
    expect(await readFile(join(repository, "scripts/build-bash-web-shell.sh"), "utf8")).toBe(`commit=${newBashRevision}\n`);
  } finally { await rm(root, { recursive: true, force: true }); }
});
