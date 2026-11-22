import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import release from "./waffle-release-inputs.json";
import { releaseDownload } from "./ci-release-download";

type Release = typeof release;
type Download = (url: string) => Promise<Response>;
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const waffleRuntimeName = "@waffle-os/runtime";
export const waffleRuntimePin = `npm:${waffleRuntimeName}@${release.version}`;

type HostInterface = number & { readonly __brand: "WaffleHostInterface" };

export function parseHostInterface(value: unknown, source: string): HostInterface {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${source}: waffleHostInterface must be a positive safe integer`);
  return value as HostInterface;
}

export function packageHostInterface(metadata: unknown, source: string): HostInterface {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error(`${source}: missing waffleHostInterface package metadata`);
  return parseHostInterface("waffleHostInterface" in metadata ? metadata.waffleHostInterface : undefined, source);
}

export function assertExactHostInterface(required: HostInterface, provided: HostInterface, source: string): void {
  if (required !== provided)
    throw new Error(`${source}: waffleHostInterface ${required} does not match runtime ${provided}`);
}

function verifyArchiveManifest(archive: string, selected: Release) {
  const result = Bun.spawnSync(["tar", "-xOf", archive, "package/package.json"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`Missing Waffle archive package metadata: ${archive}`);
  const metadata = JSON.parse(result.stdout.toString());
  assertExactHostInterface(parseHostInterface(selected.hostInterface, "Waffle release inputs"), packageHostInterface(metadata, archive), archive);
  if (metadata.name !== waffleRuntimeName || metadata.version !== selected.version)
    throw new Error(`Waffle archive identity does not match the pinned release: ${archive}`);
  if (hash(result.stdout) !== selected.packageManifestSha256)
    throw new Error(`Waffle archive manifest checksum mismatch: ${archive}`);
}

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
  download: Download = releaseDownload,
  selected: Release = release,
): Promise<string> {
  if (peer !== `npm:${waffleRuntimeName}@${selected.version}`) throw new Error("Waffle release pin does not match its checked source inputs");
  await pinnedFile(archive, selected.url, selected.sha256, download);
  if (Bun.file(archive).size !== selected.bytes) throw new Error("Waffle release archive size mismatch");
  verifyArchiveManifest(archive, selected);
  return archive;
}

export async function prepareWaffleNativeInputs(
  repository: string,
  directory: string,
  download: Download = releaseDownload,
  selected: Release = release,
): Promise<string> {
  const manifest = await Bun.file(join(repository, "package.json")).json();
  if (manifest.devDependencies?.[waffleRuntimeName] !== selected.version ||
    manifest.devDependencies?.waffle !== `npm:${waffleRuntimeName}@${selected.version}`)
    throw new Error("Waffle release pin does not match its checked source inputs");
  const installed = dirname(Bun.resolveSync(`${waffleRuntimeName}/package.json`, repository));
  if (await realpath(join(installed, "package.json")) !== await realpath(Bun.resolveSync("waffle/package.json", repository)))
    throw new Error("Waffle runtime and its npm alias must resolve to one physical package");
  const installedManifest = await Bun.file(join(installed, "package.json")).bytes();
  const metadata = JSON.parse(new TextDecoder().decode(installedManifest));
  if (metadata.name !== waffleRuntimeName || metadata.version !== selected.version) throw new Error("Installed Waffle identity does not match the pinned release");
  const required = parseHostInterface(selected.hostInterface, "Waffle release inputs");
  assertExactHostInterface(packageHostInterface(manifest, "Bun package"), required, "Bun package");
  assertExactHostInterface(packageHostInterface(metadata, "Installed Waffle"), required, "Installed Waffle");
  if (hash(installedManifest) !== selected.packageManifestSha256) throw new Error("Installed Waffle manifest differs from the npm archive");
  const archive = join(dirname(directory), "runtime.tgz");
  await prepareWaffleReleaseArchive(manifest.devDependencies.waffle, archive, download, selected);
  if (hash(await Bun.file(join(installed, "scripts/build-wasi-libc.sh")).bytes()) !== selected.files["scripts/build-wasi-libc.sh"])
    throw new Error("Installed Waffle builder differs from its released source");
  for (const [path, sha256] of Object.entries(selected.files)) {
    const url = `https://raw.githubusercontent.com/ShaulLavo/waffle/${selected.sourceCommit}/${selected.packagePath}/${path}`;
    await pinnedFile(join(directory, path), url, sha256, download);
  }
  assertExactHostInterface(packageHostInterface(await Bun.file(join(directory, "package.json")).json(), "Waffle source package"), required, "Waffle source package");
  return directory;
}

export async function releasedWaffleNativeInputs(repository: string): Promise<string> {
  return prepareWaffleNativeInputs(repository, waffleNativeDirectory());
}
