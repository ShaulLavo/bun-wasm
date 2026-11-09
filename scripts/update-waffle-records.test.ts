import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCacheKey } from "./ci-release-download";
import record from "./waffle-release-inputs.json";
// The published programs-v0.0.15 manifest, keeping only the waffle-base package and no install receipt.
import published from "./fixtures/program-release-v0.0.15.trimmed.json";

type Manifest = Record<string, unknown> & { packages: Array<Record<string, unknown>> };

const updater = join(import.meta.dir, "../.github/scripts/update-waffle-records.sh");
const encode = (text: string) => new TextEncoder().encode(text);
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const runtimeFiles = ["package.json", "scripts/build-wasi-libc.sh", "patches/wasi-libc/preopen-scan.patch"] as const;

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
[[ "$url" != *'/releases/download/'* ]] || { echo 'Public releases forbidden in this fixture' >&2; exit 22; }
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

async function serve(root: string, routes: string[], url: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, "served", String(routes.length));
  await writeFile(path, bytes);
  if (url.includes("/releases/download/")) await writeFile(join(root, "assets", releaseCacheKey(url)), bytes);
  routes.push(`${url}\t${path}`);
  return path;
}

async function packFixture(root: string, name: string, files: Readonly<Record<string, Uint8Array>>) {
  for (const [file, bytes] of Object.entries(files)) await Bun.write(join(root, name, "package", file), bytes);
  const archive = join(root, `${name}.tgz`);
  const packed = Bun.spawnSync(["tar", "-czf", archive, "-C", join(root, name), "package"]);
  expect(packed.exitCode).toBe(0);
  return Bun.file(archive).bytes();
}

const matchingInterfaces = { runtime: record.hostInterface, relay: record.hostInterface, programs: record.hostInterface, base: record.hostInterface };

async function fixture(manifest: Manifest, interfaces: Record<keyof typeof matchingInterfaces, unknown> = matchingInterfaces) {
  const root = await mkdtemp(join(tmpdir(), "waffle-records-"));
  const repository = join(root, "repository");
  await mkdir(join(repository, "scripts"), { recursive: true });
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "served"));
  await mkdir(join(root, "assets"));
  await copyFile(join(import.meta.dir, "ci-release-download.ts"), join(repository, "scripts/ci-release-download.ts"));
  const originalBase = manifest.packages.find(entry => entry.name === "waffle-base");
  if (!originalBase || typeof originalBase.version !== "string") throw new Error("Missing fixture base version");
  const base = await packFixture(root, "base", { "package.json": encode(JSON.stringify({ name: "waffle-base",
    version: originalBase.version, waffleHostInterface: interfaces.base, peerDependencies: { waffle: "*" } })) });
  const tagged = { ...manifest,
    runtime: { ...published.runtime, waffleHostInterface: interfaces.programs },
    packages: manifest.packages.map((entry) => ({ ...entry, waffleHostInterface: interfaces.programs,
      ...(entry.name === "waffle-base" ? { bytes: base.length, sha256: digest(base) } : {}) })),
  };
  const manifestBytes = encode(JSON.stringify(tagged));
  const routes: string[] = [];
  const runtimeContents = {
    "package.json": encode(JSON.stringify({ name: "waffle", version: record.version, waffleHostInterface: interfaces.runtime })),
    "scripts/build-wasi-libc.sh": encode("exact released builder"),
    "patches/wasi-libc/preopen-scan.patch": encode("exact reviewed source patch"),
  };
  await serve(root, routes, record.url, await packFixture(root, "runtime", runtimeContents));
  const relayMetadata = { name: "waffle-relay", version: record.relay.version, waffleHostInterface: interfaces.relay, peerDependencies: { waffle: "*" } };
  const relay = await packFixture(root, "relay", { "package.json": encode(JSON.stringify(relayMetadata)) });
  await serve(root, routes, record.relay.url, relay);
  await serve(root, routes, baseUrl(tagged), base);
  const manifestUrl = baseUrl(tagged).replace(/\/[^/]+$/, "/program-release.json");
  await serve(root, routes, manifestUrl, manifestBytes);
  const sourcePaths = new Map<string, string>();
  for (const file of runtimeFiles) sourcePaths.set(file, await serve(root, routes,
    `https://raw.githubusercontent.com/ShaulLavo/waffle/${record.sourceCommit}/packages/waffle/${file}`, runtimeContents[file]));
  await writeFile(join(root, "routes"), `${routes.join("\n")}\n`);
  await writeFile(join(root, "bin/curl"), fakeCurl);
  await writeFile(join(root, "bin/git"), fakeGit);
  await chmod(join(root, "bin/curl"), 0o755);
  await chmod(join(root, "bin/git"), 0o755);
  await writeFile(join(repository, "package.json"), JSON.stringify({
    waffleHostInterface: record.hostInterface,
    devDependencies: { waffle: record.url },
    peerDependencies: { "waffle-base": baseUrl(tagged), "waffle-relay": record.relay.url },
  }));
  const before = JSON.stringify(record, null, 2);
  await writeFile(join(repository, "scripts/waffle-release-inputs.json"), before);
  const basePin = { url: baseUrl(tagged), bytes: base.length, sha256: digest(base),
    sourceDirectory: originalBase.sourceDirectory, sourceTree: originalBase.sourceTree, version: originalBase.version };
  return { root, repository, before, manifestBytes, manifestUrl, base, basePin, relay, sourcePaths };
}

function runUpdater(root: string, repository: string) {
  return Bun.spawnSync(["bash", updater], {
    cwd: repository,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, RUNNER_TEMP: root,
      CI_RELEASE_CACHE: join(root, "assets"), GITHUB_ACTIONS: "true", GITHUB_TOKEN: "",
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
      expect(result.stderr.toString()).toContain("GitHub release cache hit:");
      expect(result.exitCode).toBe(0);
      expect((await readRecord(f.repository)).programs).toEqual({
        tag: "programs-v0.0.15",
        sourceCommit: published.sourceCommit,
        manifest: { url: f.manifestUrl, bytes: f.manifestBytes.length, sha256: digest(f.manifestBytes) },
        base: f.basePin,
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


test("the updater binds relay bytes and source to its exact-interface release", async () => {
  const f = await fixture(published);
  try {
    expect(runUpdater(f.root, f.repository).exitCode).toBe(0);
    expect((await readRecord(f.repository)).relay).toEqual({
      ...record.relay, bytes: f.relay.length, sha256: digest(f.relay),
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


for (const component of ["runtime", "relay", "programs", "base"] as const) {
  for (const value of [undefined, null, 1, 3, "2"]) test(`${component} rejects nonmatching interface ${JSON.stringify(value)} without rewriting the record`, async () => {
    const f = await fixture(published, { ...matchingInterfaces, [component]: value });
    try {
      const result = runUpdater(f.root, f.repository);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("host interface");
      expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

test("the updater rejects a native source file that differs from the runtime archive", async () => {
  const f = await fixture(published);
  try {
    const source = f.sourcePaths.get("scripts/build-wasi-libc.sh");
    if (!source) throw new Error("Missing fixture builder source");
    await writeFile(source, "different native builder");
    const result = runUpdater(f.root, f.repository);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Runtime archive differs from its tagged source");
    expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("the updater refuses a same-version runtime URL outside its release before writing", async () => {
  const f = await fixture(published);
  try {
    const path = join(f.repository, "package.json");
    await writeFile(path, JSON.stringify({ waffleHostInterface: record.hostInterface,
      devDependencies: { waffle: record.url.replace("github.com", "example.invalid") },
      peerDependencies: { "waffle-base": f.basePin.url, "waffle-relay": record.relay.url } }));
    const result = runUpdater(f.root, f.repository);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("canonical Waffle release");
    expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test("a partial final write preserves the complete record and removes its sibling stage", async () => {
  const f = await fixture(published);
  try {
    await writeFile(join(f.root, "bin/cat"), '#!/usr/bin/env bash\nprintf copied > "$FIXTURE_ROOT/final-copy"\nhead -c 32 "$1"\nexit 1\n');
    await chmod(join(f.root, "bin/cat"), 0o755);
    expect(runUpdater(f.root, f.repository).exitCode).not.toBe(0);
    expect(await readFile(join(f.root, "final-copy"), "utf8")).toBe("copied");
    expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
    const files = await readdir(join(f.repository, "scripts"));
    expect(files.sort()).toEqual(["ci-release-download.ts", "waffle-release-inputs.json"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("atomic record replacement preserves the existing file mode", async () => {
  const f = await fixture(published);
  try {
    const path = join(f.repository, "scripts/waffle-release-inputs.json");
    await chmod(path, 0o640);
    expect(runUpdater(f.root, f.repository).exitCode).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect((await readRecord(f.repository)).programs.tag).toBe(published.tag);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const value of [undefined, null, 0, "", "short", "g".repeat(40)]) {
  test(`the updater rejects original program source ${JSON.stringify(value)} without replacing it`, async () => {
    const f = await fixture({ ...published, sourceCommit: value });
    try {
      const result = runUpdater(f.root, f.repository);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("original program source commit");
      expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}

const invalidBaseSources = [
  { field: "sourceTree", value: undefined }, { field: "sourceTree", value: null },
  { field: "sourceTree", value: 0 }, { field: "sourceTree", value: "short" },
  { field: "sourceTree", value: "g".repeat(40) },
  { field: "sourceDirectory", value: undefined }, { field: "sourceDirectory", value: null },
  { field: "sourceDirectory", value: "" }, { field: "sourceDirectory", value: "/packages/base" },
  { field: "sourceDirectory", value: "packages/../base" }, { field: "sourceDirectory", value: "packages//base" },
  { field: "sourceDirectory", value: "packages/./base" }, { field: "sourceDirectory", value: "packages\\base" },
  { field: "sourceDirectory", value: "packages/\u0000base" },
];
for (const { field, value } of invalidBaseSources) {
  test(`the updater rejects base ${field} ${JSON.stringify(value)} without replacing it`, async () => {
    const manifest = { ...published, packages: published.packages.map(entry =>
      entry.name === "waffle-base" ? { ...entry, [field]: value } : entry) };
    const f = await fixture(manifest);
    try {
      const result = runUpdater(f.root, f.repository);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("Base source directory or tree");
      expect(await readFile(join(f.repository, "scripts/waffle-release-inputs.json"), "utf8")).toBe(f.before);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
}
