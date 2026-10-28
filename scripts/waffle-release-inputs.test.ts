import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import release from "./waffle-release-inputs.json";
import { prepareWaffleNativeInputs, prepareWaffleReleaseArchive } from "./waffle-release-inputs";

const encode = (text: string) => new TextEncoder().encode(text);
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "waffle-native-inputs-"));
  const repository = join(root, "repository");
  const installed = join(repository, "node_modules/waffle");
  const directory = join(root, "native", "packages/waffle");
  const archive = encode("exact released runtime archive");
  const files = {
    "package.json": encode(JSON.stringify({ name: "waffle", version: release.version })),
    "scripts/build-wasi-libc.sh": encode("exact released builder"),
    "patches/wasi-libc/preopen-scan.patch": encode("exact reviewed source patch"),
  };
  const selected = { ...release, sha256: digest(archive), bytes: archive.length, files: {
    "package.json": digest(files["package.json"]),
    "scripts/build-wasi-libc.sh": digest(files["scripts/build-wasi-libc.sh"]),
    "patches/wasi-libc/preopen-scan.patch": digest(files["patches/wasi-libc/preopen-scan.patch"]),
  } };
  await mkdir(join(installed, "scripts"), { recursive: true });
  await writeFile(join(repository, "package.json"), JSON.stringify({ devDependencies: { waffle: selected.url } }));
  await writeFile(join(installed, "package.json"), files["package.json"]);
  await writeFile(join(installed, "scripts/build-wasi-libc.sh"), files["scripts/build-wasi-libc.sh"]);
  const downloads = new Map<string, Uint8Array<ArrayBuffer>>([[selected.url, archive]]);
  for (const [path, bytes] of Object.entries(files))
    downloads.set(`https://raw.githubusercontent.com/ShaulLavo/waffle/${selected.sourceCommit}/${selected.packagePath}/${path}`, bytes);
  const requests: string[] = [];
  const download = async (url: string) => {
    requests.push(url);
    const bytes = downloads.get(url);
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  };
  return { root, repository, installed, directory, selected, files, downloads, requests, download };
}

test("the release and reviewed monorepo native inputs are verified and reused without archive writes", async () => {
  const f = await fixture();
  try {
    expect(await prepareWaffleNativeInputs(f.repository, f.directory, f.download, f.selected)).toBe(f.directory);
    expect(await readFile(join(f.directory, "patches/wasi-libc/preopen-scan.patch"), "utf8")).toBe("exact reviewed source patch");
    expect(await Bun.file(join(f.installed, "patches/wasi-libc/preopen-scan.patch")).exists()).toBe(false);
    expect(f.requests).toHaveLength(4);
    await prepareWaffleNativeInputs(f.repository, f.directory, f.download, f.selected);
    expect(f.requests).toHaveLength(4);
    await writeFile(join(f.directory, "patches/wasi-libc/preopen-scan.patch"), "corrupt cached input");
    await expect(prepareWaffleNativeInputs(f.repository, f.directory, f.download, f.selected)).rejects.toThrow("checksum mismatch");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a different archive or source file cannot satisfy the release binding", async () => {
  for (const member of ["archive", "patch"]) {
    const f = await fixture();
    try {
      const url = member === "archive" ? f.selected.url : `https://raw.githubusercontent.com/ShaulLavo/waffle/${f.selected.sourceCommit}/${f.selected.packagePath}/patches/wasi-libc/preopen-scan.patch`;
      f.downloads.set(url, encode("unselected bytes"));
      await expect(prepareWaffleNativeInputs(f.repository, f.directory, f.download, f.selected)).rejects.toThrow("checksum mismatch");
      expect(await Bun.file(join(f.directory, "patches/wasi-libc/preopen-scan.patch")).exists()).toBe(false);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test("an unselected dependency or installed builder fails before source preparation", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repository, "package.json"), JSON.stringify({ devDependencies: { waffle: "git+https://github.com/ShaulLavo/waffle.git#unselected" } }));
    await expect(prepareWaffleNativeInputs(f.repository, f.directory, f.download, f.selected)).rejects.toThrow("release pin");
    expect(f.requests).toEqual([]);
    await writeFile(join(f.repository, "package.json"), JSON.stringify({ devDependencies: { waffle: f.selected.url } }));
    await writeFile(join(f.installed, "scripts/build-wasi-libc.sh"), "different builder");
    await expect(prepareWaffleNativeInputs(f.repository, f.directory, f.download, f.selected)).rejects.toThrow("builder differs");
    expect(await Bun.file(join(f.directory, "scripts/build-wasi-libc.sh")).exists()).toBe(false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("archive-only staging rejects a different peer and enforces the release byte count", async () => {
  const f = await fixture();
  try {
    const archive = join(f.root, "archive # with spaces.tgz");
    await expect(prepareWaffleReleaseArchive(f.selected.url + "#different", archive, f.download, f.selected)).rejects.toThrow("release pin");
    expect(f.requests).toEqual([]);
    await expect(prepareWaffleReleaseArchive(f.selected.url, archive, f.download, { ...f.selected, bytes: f.selected.bytes + 1 })).rejects.toThrow("archive size");
    expect(await prepareWaffleReleaseArchive(f.selected.url, archive, f.download, f.selected)).toBe(archive);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
