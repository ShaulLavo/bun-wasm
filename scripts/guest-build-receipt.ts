import { basename, dirname, join, resolve } from "node:path";
import { captureSourceManifest, git, guestBuilds, guestToolEnvironment, hash, run, sourceOptions, type GuestBuild, type SourceManifest, type SourceOptions } from "./guest-source-manifest.ts";

const root = resolve(import.meta.dir, "..");

export interface GuestBuildInputs {
  readonly bunHead: string;
  readonly bunTree: string;
  readonly sysrootReceiptSha256: string;
  readonly sourceManifest: SourceManifest;
  readonly sourceManifestSha256: string;
}

export interface GuestBuildReceipt extends GuestBuildInputs {
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly quickjs?: { readonly artifactSha256: string; readonly artifactBytes: number };
}

async function readInputs(options: SourceOptions): Promise<GuestBuildInputs> {
  const { repository, sysroot } = options;
  const vendor = join(repository, "vendor/bun");
  if (git(vendor, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Guest source changed during the build: vendor/bun has local changes");
  const sourceManifest = await captureSourceManifest(options);
  return {
    bunHead: git(vendor, "rev-parse", "HEAD"),
    bunTree: git(vendor, "rev-parse", "HEAD^{tree}"),
    sysrootReceiptSha256: hash(await Bun.file(join(sysroot, "bun-wasm-sysroot.json")).bytes()),
    sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)),
  };
}

export async function prepareGuestBuildInputs(options: SourceOptions): Promise<GuestBuildInputs> {
  run(["bash", join(options.repository, "scripts/sync-bun.sh"), "--check"], options.repository);
  return readInputs(options);
}

export async function writeGuestBuildReceipt(options: SourceOptions, artifact: string, inputs: GuestBuildInputs): Promise<GuestBuildReceipt> {
  const current = await readInputs(options);
  const unchanged = current.bunHead === inputs.bunHead && current.bunTree === inputs.bunTree
    && current.sysrootReceiptSha256 === inputs.sysrootReceiptSha256 && current.sourceManifestSha256 === inputs.sourceManifestSha256;
  if (!unchanged) throw new Error("Guest source or toolchain changed during the build");
  if (basename(artifact) !== guestBuilds[inputs.sourceManifest.build].artifact) throw new Error("Guest artifact name does not match selected build");
  const bytes = await Bun.file(artifact).bytes();
  const quickjs = await quickjsIdentity(options.build, dirname(artifact));
  const receipt = { ...inputs, artifactSha256: hash(bytes), artifactBytes: bytes.byteLength, ...quickjs };
  verifyGuestBuildReceipt(bytes, receipt);
  await Bun.write(`${artifact}.build.json`, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

function splitBuild(build: GuestBuild): boolean {
  return build === "quickjs" || build === "quickjs-minimal";
}

async function quickjsIdentity(build: GuestBuild, directory: string) {
  if (!splitBuild(build)) return {};
  const bytes = await Bun.file(join(directory, "quickjs.wasm")).bytes();
  if (!WebAssembly.validate(bytes)) throw new Error("Invalid paired QuickJS module");
  return { quickjs: { artifactSha256: hash(bytes), artifactBytes: bytes.byteLength } };
}

export async function verifyGuestCompanions(receipt: GuestBuildReceipt, directory: string): Promise<void> {
  if (!splitBuild(receipt.sourceManifest.build)) return;
  const identity = await quickjsIdentity(receipt.sourceManifest.build, directory);
  if (identity.quickjs?.artifactSha256 !== receipt.quickjs?.artifactSha256
    || identity.quickjs?.artifactBytes !== receipt.quickjs?.artifactBytes) throw new Error("Guest receipt does not match paired QuickJS bytes");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value: unknown, length: number): boolean {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function validFiles(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  return value.every(file => record(file) && typeof file.path === "string" && file.path.length > 0
    && !file.path.startsWith("/") && !file.path.split("/").includes("..")
    && digest(file.sha256, 64) && Number.isSafeInteger(file.bytes) && Number(file.bytes) >= 0)
    && new Set(value.map(file => file.path)).size === value.length;
}

function verifyManifest(value: unknown): asserts value is SourceManifest {
  if (!record(value) || value.schema !== 1 || !isGuestBuild(value.build)) throw new Error("Invalid guest source manifest schema/build");
  if (!record(value.source) || !digest(value.source.head, 40) || !digest(value.source.tree, 40)) throw new Error("Invalid guest source manifest commit/tree");
  if (!Array.isArray(value.groups) || !value.groups.every(group => record(group) && typeof group.name === "string" && validFiles(group.files))) throw new Error("Invalid guest source manifest files");
  const required = ["repository", "bun", "waffle-libc", "sysroot", "sdk", "rust-target", "boringssl"];
  if (value.build === "jsc" || value.build === "tools") required.push("jsc-prebuild");
  const names = value.groups.map(group => group.name);
  if (new Set(names).size !== names.length || required.some(name => !names.includes(name))) throw new Error("Missing guest source manifest group");
  if (!Array.isArray(value.tools) || !value.tools.every(tool => record(tool) && typeof tool.name === "string" && typeof tool.path === "string" && tool.path.length > 0 && digest(tool.sha256, 64) && typeof tool.version === "string" && tool.version.length > 0)) throw new Error("Invalid guest source manifest tools");
  const tools = value.tools.map(tool => tool.name);
  if (new Set(tools).size !== tools.length || ["rustc", "cargo", "bun", "node", "rust-lld", "clang", "clang++", "llvm-ar", "wasm-ld", "cmake", "ninja"].some(name => !tools.includes(name))) throw new Error("Missing guest source manifest tool");
  if (guestBuilds[value.build].optimizer === "required" && !tools.includes("wasm-opt")) throw new Error("Missing guest optimizer identity");
  if (!Array.isArray(value.omissions) || !value.omissions.length || !value.omissions.every(item => typeof item === "string" && item.length > 0)) throw new Error("Missing guest source manifest omissions");
}

function isGuestBuild(value: unknown): value is GuestBuild {
  return typeof value === "string" && Object.hasOwn(guestBuilds, value);
}

export function verifyGuestBuildReceipt(bytes: Uint8Array, value: unknown): asserts value is GuestBuildReceipt {
  if (!record(value)) throw new Error("Invalid guest build receipt");
  for (const [field, length] of [["bunHead", 40], ["bunTree", 40], ["sysrootReceiptSha256", 64], ["artifactSha256", 64], ["sourceManifestSha256", 64]] as const) {
    if (!digest(value[field], length)) throw new Error(`Invalid guest build receipt: ${field}`);
  }
  verifyManifest(value.sourceManifest);
  if (hash(JSON.stringify(value.sourceManifest)) !== value.sourceManifestSha256) throw new Error("Guest source manifest digest mismatch");
  const sysroot = value.sourceManifest.groups.find(group => group.name === "sysroot");
  if (sysroot?.files.find(file => file.path === "bun-wasm-sysroot.json")?.sha256 !== value.sysrootReceiptSha256) throw new Error("Guest sysroot receipt differs from source manifest");
  if (splitBuild(value.sourceManifest.build) && (!record(value.quickjs)
    || !digest(value.quickjs.artifactSha256, 64) || !Number.isSafeInteger(value.quickjs.artifactBytes)
    || Number(value.quickjs.artifactBytes) <= 0)) throw new Error("Missing paired QuickJS identity");
  if (value.artifactBytes !== bytes.byteLength || value.artifactSha256 !== hash(bytes)) throw new Error("Guest build receipt does not match artifact bytes");
}

if (import.meta.main) {
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot) throw new Error("Source env.sh before building a guest");
  const [command, argument, snapshot] = process.argv.slice(2);
  if (command === "environment") {
    console.log(guestToolEnvironment(root));
  } else if (command === "inputs" && isGuestBuild(argument)) {
    console.log(JSON.stringify(await prepareGuestBuildInputs(sourceOptions(root, sysroot, argument))));
  } else if (command === "write" && argument && snapshot) {
    const inputs: unknown = await Bun.file(snapshot).json();
    const bytes = await Bun.file(argument).bytes();
    if (!record(inputs)) throw new Error("Invalid guest build inputs");
    verifyManifest(inputs.sourceManifest);
    const quickjs = await quickjsIdentity(inputs.sourceManifest.build, dirname(argument));
    const receipt = { ...inputs, artifactSha256: hash(bytes), artifactBytes: bytes.byteLength, ...quickjs };
    verifyGuestBuildReceipt(bytes, receipt);
    await writeGuestBuildReceipt(sourceOptions(root, sysroot, receipt.sourceManifest.build), argument, receipt);
  } else {
    throw new Error("Usage: guest-build-receipt.ts environment | inputs BUILD | write ARTIFACT INPUTS_FILE");
  }
}
