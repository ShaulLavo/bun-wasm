import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import record from "./waffle-release-inputs.json";
// The published programs-v0.0.15 manifest, keeping only the waffle-base package and no install receipt.
import published from "./fixtures/program-release-v0.0.15.trimmed.json";

type Manifest = Record<string, unknown> & { packages: Array<Record<string, unknown>> };

const updater = join(import.meta.dir, "../.github/scripts/update-waffle-records.sh");
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const runtimeFiles = ["package.json", "scripts/build-wasi-libc.sh", "patches/wasi-libc/preopen-scan.patch"];

// Network commands answer from a route table, so the real updater runs offline.
const fakeCurl = `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
source=$(awk -F '\\t' -v url="$url" '$1 == url { print $2 }' "$FIXTURE_ROOT/routes")
[[ -n "$source" ]] || { echo "unrouted $url" >&2; exit 22; }
cp "$source" "$out"
`;
const fakeGit = `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == ls-remote ]] || { echo "unexpected git $*" >&2; exit 2; }
printf '%s\\trefs/tags/waffle-v%s\\n' "$FIXTURE_REVISION" "${record.version}"
`;

function baseUrl(manifest: Manifest): string {
  const base = manifest.packages.find((entry) => entry.name === "waffle-base");
  if (!base || typeof base.url !== "string") throw new Error("fixture manifest lacks waffle-base");
  return base.url;
}

async function serve(root: string, routes: string[], url: string, bytes: Uint8Array): Promise<void> {
  const path = join(root, "served", String(routes.length));
  await writeFile(path, bytes);
  routes.push(`${url}\t${path}`);
}

async function fixture(manifest: Manifest) {
  const root = await mkdtemp(join(tmpdir(), "waffle-records-"));
  const repository = join(root, "repository");
  await mkdir(join(repository, "scripts"), { recursive: true });
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "served"));
  const base = encode("waffle-base archive");
  const tagged = { ...manifest, packages: manifest.packages.map((entry) =>
    entry.name === "waffle-base" ? { ...entry, bytes: base.length, sha256: digest(base) } : entry) };
  const manifestBytes = encode(JSON.stringify(tagged));
  const routes: string[] = [];
  await serve(root, routes, record.url, encode("waffle runtime archive"));
  await serve(root, routes, baseUrl(tagged), base);
  await serve(root, routes, `${record.programs.manifest.url}`, manifestBytes);
  for (const file of runtimeFiles)
    await serve(root, routes, `https://raw.githubusercontent.com/ShaulLavo/waffle/${record.sourceCommit}/packages/waffle/${file}`, encode(file));
  await writeFile(join(root, "routes"), `${routes.join("\n")}\n`);
  await writeFile(join(root, "bin/curl"), fakeCurl);
  await writeFile(join(root, "bin/git"), fakeGit);
  await chmod(join(root, "bin/curl"), 0o755);
  await chmod(join(root, "bin/git"), 0o755);
  await writeFile(join(repository, "package.json"), JSON.stringify({
    devDependencies: { waffle: record.url },
    peerDependencies: { "waffle-base": baseUrl(tagged) },
  }));
  const before = JSON.stringify(record, null, 2);
  await writeFile(join(repository, "scripts/waffle-release-inputs.json"), before);
  return { root, repository, before, manifestBytes, base };
}

function runUpdater(root: string, repository: string) {
  return Bun.spawnSync(["bash", updater], {
    cwd: repository,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root,
      FIXTURE_ROOT: root, FIXTURE_REVISION: record.sourceCommit },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const readRecord = async (repository: string) =>
  JSON.parse(await readFile(join(repository, "scripts/waffle-release-inputs.json"), "utf8"));

test("a published peer rebind keeps its schema and rebind tool commit through every update", async () => {
  const f = await fixture(published);
  try {
    for (let round = 0; round < 2; round++) {
      const result = runUpdater(f.root, f.repository);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect((await readRecord(f.repository)).programs).toEqual({
        tag: "programs-v0.0.15",
        sourceCommit: published.sourceCommit,
        manifest: { url: record.programs.manifest.url, bytes: f.manifestBytes.length, sha256: digest(f.manifestBytes) },
        base: { ...record.programs.base, bytes: f.base.length, sha256: digest(f.base) },
        schema: "waffle-program-release/2",
        toolCommit: published.rebind.toolCommit,
      });
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a normal release records the source commit whose tools packed it", async () => {
  const { rebind: _, ...release } = published;
  const f = await fixture({ ...release, operation: "release" });
  try {
    expect(runUpdater(f.root, f.repository).exitCode).toBe(0);
    const programs = (await readRecord(f.repository)).programs;
    expect(programs.schema).toBe("waffle-program-release/2");
    expect(programs.toolCommit).toBe(published.sourceCommit);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

const rejected: Array<[string, Manifest, string]> = [
  ["schema 1", { ...published, schema: "waffle-program-release/1" }, "Unsupported program release schema"],
  ["another tag", { ...published, tag: "programs-v0.0.14" }, "names programs-v0.0.14"],
  ["a dirty pack", { ...published, dirty: true }, "clean tag"],
  ["an untagged candidate", { ...published, tagState: "untagged-candidate" }, "clean tag"],
  ["an unknown operation", { ...published, operation: "repack" }, "Unsupported program release operation"],
  ["dirty rebind tools", { ...published, rebind: { ...published.rebind, toolDirty: true } }, "rebind tools were not clean"],
  ["a missing rebind tool commit", { ...published, rebind: { ...published.rebind, toolCommit: undefined } }, "not a full revision"],
  ["a short rebind tool commit", { ...published, rebind: { ...published.rebind, toolCommit: "acd64c1" } }, "not a full revision"],
];

for (const [label, manifest, diagnostic] of rejected) {
  test(`${label} leaves the release record untouched`, async () => {
    const f = await fixture(manifest);
    try {
      const result = runUpdater(f.root, f.repository);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(diagnostic);
      expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
