import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import release from "./waffle-release-inputs.json";

type Release = typeof release;
type Download = (url: string) => Promise<Response>;
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export function waffleNativeDirectory(): string {
  const tools = process.env.WASM_TOOLS;
  if (!tools) throw new Error("Source env.sh before resolving Waffle native inputs");
  return join(tools, "waffle-native", release.sourceCommit, release.packagePath);
}

async function pinnedFile(path: string, url: string, sha256: string, download: Download): Promise<void> {
  const file = Bun.file(path);
  if (await file.exists()) {
    if (hash(await file.bytes()) !== sha256) throw new Error(`Waffle input checksum mismatch: ${path}`);
    return;
  }
  const response = await download(url);
  if (!response.ok) throw new Error(`Waffle input download failed: ${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hash(bytes) !== sha256) throw new Error(`Waffle input checksum mismatch: ${url}`);
  await mkdir(dirname(path), { recursive: true });
  const stage = await mkdtemp(join(dirname(path), ".waffle-input-"));
  try {
    await Bun.write(join(stage, "input"), bytes);
    await rename(join(stage, "input"), path);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function prepareWaffleReleaseArchive(
  peer: string,
  archive: string,
  download: Download = fetch,
  selected: Release = release,
): Promise<string> {
  if (peer !== selected.url) throw new Error("Waffle release pin does not match its checked source inputs");
  await pinnedFile(archive, selected.url, selected.sha256, download);
  if (Bun.file(archive).size !== selected.bytes) throw new Error("Waffle release archive size mismatch");
  return archive;
}

export async function prepareWaffleNativeInputs(
  repository: string,
  directory: string,
  download: Download = fetch,
  selected: Release = release,
): Promise<string> {
  const manifest = await Bun.file(join(repository, "package.json")).json();
  if (manifest.devDependencies?.waffle !== selected.url) throw new Error("Waffle release pin does not match its checked source inputs");
  const installed = dirname(Bun.resolveSync("waffle/package.json", repository));
  const metadata = await Bun.file(join(installed, "package.json")).json();
  if (metadata.name !== "waffle" || metadata.version !== selected.version) throw new Error("Installed Waffle identity does not match the pinned release");
  const archive = join(dirname(directory), "runtime.tgz");
  await prepareWaffleReleaseArchive(manifest.devDependencies.waffle, archive, download, selected);
  if (hash(await Bun.file(join(installed, "scripts/build-wasi-libc.sh")).bytes()) !== selected.files["scripts/build-wasi-libc.sh"])
    throw new Error("Installed Waffle builder differs from its released source");
  for (const [path, sha256] of Object.entries(selected.files)) {
    const url = `https://raw.githubusercontent.com/ShaulLavo/waffle/${selected.sourceCommit}/${selected.packagePath}/${path}`;
    await pinnedFile(join(directory, path), url, sha256, download);
  }
  return directory;
}

export async function releasedWaffleNativeInputs(repository: string): Promise<string> {
  return prepareWaffleNativeInputs(repository, waffleNativeDirectory());
}
