import { captureProgramInputs, inputProfile, parseProgramReceipt, verifyProgramReceipt, type ProgramBuildReceipt } from "./guest-core-receipt.ts";
import { importedMemory, parseProgramFiles, programKind, programKindForBuild, programProfile, sharedGroupPair, verifyProgramSide, type ProgramFiles } from "../src/engine-kind.ts";
import { basename, dirname, join, resolve } from "node:path";
import { captureSourceManifest, git, guestBuilds, guestToolEnvironment, hash, run, sourceOptions, type GuestBuild, type SourceManifest, type SourceOptions } from "./guest-source-manifest.ts";
import { parseProgramProfile, verifySharedSysroot, verifySplitSysroot, type ProgramProfile } from "./src/program-profile.ts";

const root = resolve(import.meta.dir, "..");

export interface GuestBuildInputs {
  readonly profile?: "shared-group";
  readonly bunHead: string;
  readonly bunTree: string;
  readonly sysrootReceiptSha256: string;
  readonly sourceManifest: SourceManifest;
  readonly sourceManifestSha256: string;
}

export interface ArtifactIdentity {
  readonly artifactSha256: string;
  readonly artifactBytes: number;
}
type SingleProgram = Extract<ProgramFiles<ArtifactIdentity>, { kind: "single" }>;
type PairedProgram = Exclude<ProgramFiles<ArtifactIdentity>, { kind: "single" }>;
type ReceiptProgram = { readonly program: SingleProgram } | {
  readonly program: PairedProgram;
  readonly engineOrigin: ProgramBuildReceipt;
  readonly engineInputSha256: string;
};
export type GuestBuildReceipt = GuestBuildInputs & ReceiptProgram;
export function artifactIdentity(bytes: Uint8Array): ArtifactIdentity {
  return { artifactSha256: hash(bytes), artifactBytes: bytes.byteLength };
}
export function parseArtifactIdentity(value: unknown): ArtifactIdentity {
  if (!record(value) || !digest(value.artifactSha256, 64) || typeof value.artifactSha256 !== "string"
    || typeof value.artifactBytes !== "number" || !Number.isSafeInteger(value.artifactBytes) || value.artifactBytes < 8) throw new Error("Invalid program artifact identity");
  return { artifactSha256: value.artifactSha256, artifactBytes: value.artifactBytes };
}

function receiptProfile(value: unknown): ProgramProfile {
  if (value === undefined) return "split";
  if (value === "shared-group") return value;
  throw new Error("Guest receipt profile must be shared-group or omitted for split");
}

function checkProfile(build: GuestBuild, profile: ProgramProfile): void {
  if (profile === "shared-group" && programKindForBuild(build) !== "quickjs") throw new Error("Only QuickJS supports shared-group guest composition");
}

async function readInputs(options: SourceOptions, profile: ProgramProfile): Promise<GuestBuildInputs> {
  const { repository, sysroot } = options;
  checkProfile(options.build, profile);
  if (process.env.BUN_WASM_PROGRAM_PROFILE && parseProgramProfile(process.env.BUN_WASM_PROGRAM_PROFILE) !== profile) throw new Error("Composed profile differs from build environment");
  if (profile === "shared-group") verifySharedSysroot(sysroot);
  else verifySplitSysroot(sysroot);
  const vendor = join(repository, "vendor/bun");
  if (git(vendor, "status", "--porcelain", "--untracked-files=normal")) throw new Error("Guest source changed during the build: vendor/bun has local changes");
  const sourceManifest = await captureSourceManifest(options);
  return {
    ...(profile === "shared-group" ? { profile } : {}),
    bunHead: git(vendor, "rev-parse", "HEAD"),
    bunTree: git(vendor, "rev-parse", "HEAD^{tree}"),
    sysrootReceiptSha256: hash(await Bun.file(join(sysroot, "bun-wasm-sysroot.json")).bytes()),
    sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)),
  };
}

export async function prepareGuestBuildInputs(options: SourceOptions, profile: ProgramProfile = "split"): Promise<GuestBuildInputs> {
  checkProfile(options.build, profile);
  run(["bash", join(options.repository, "scripts/sync-bun.sh"), "--check"], options.repository);
  return readInputs(options, profile);
}

export async function writeGuestBuildReceipt(options: SourceOptions, artifact: string, inputs: GuestBuildInputs): Promise<GuestBuildReceipt> {
  const profile = receiptProfile(inputs.profile);
  const current = await readInputs(options, profile);
  const unchanged = current.bunHead === inputs.bunHead && current.bunTree === inputs.bunTree
    && current.sysrootReceiptSha256 === inputs.sysrootReceiptSha256 && current.sourceManifestSha256 === inputs.sourceManifestSha256;
  if (!unchanged) throw new Error("Guest source or toolchain changed during the build");
  if (basename(artifact) !== guestBuilds[inputs.sourceManifest.build].artifact) throw new Error("Guest artifact name does not match selected build");
  const bytes = await Bun.file(artifact).bytes();
  const fields = await receiptProgram(options, bytes, dirname(artifact), profile);
  const receipt = { ...inputs, ...fields };
  verifyGuestBuildReceipt(bytes, receipt);
  await Bun.write(`${artifact}.build.json`, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

async function programIdentity(build: GuestBuild, bytes: Uint8Array, directory: string, profile: ProgramProfile): Promise<ProgramFiles<ArtifactIdentity>> {
  const kind = programKindForBuild(build);
  if (programKind(new WebAssembly.Module(Uint8Array.from(bytes))) !== kind) throw new Error("Guest build does not match core engine declaration");
  const core = artifactIdentity(bytes);
  if (kind === "single") return { kind, core };
  const side = await Bun.file(join(directory, programProfile(kind).side)).bytes();
  verifyProgramSide(kind, new WebAssembly.Module(side));
  if (sharedGroupPair(new WebAssembly.Module(Uint8Array.from(bytes)), side) !== (profile === "shared-group")) throw new Error("Guest bytes differ from composed profile");
  return { kind, core, side: artifactIdentity(side) };
}

async function receiptProgram(options: SourceOptions, bytes: Uint8Array, directory: string, profile: ProgramProfile): Promise<ReceiptProgram> {
  checkProfile(options.build, profile);
  const program = await programIdentity(options.build, bytes, directory, profile);
  if (program.kind === "single") return { program };
  const sidePath = join(directory, programProfile(program.kind).side);
  const current = await captureProgramInputs(options, program.kind, undefined, profile);
  const engineOrigin = verifyProgramReceipt(await Bun.file(sidePath).bytes(), await Bun.file(`${sidePath}.engine.json`).json(), current);
  return { program, engineOrigin, engineInputSha256: current.contentSha256 };
}

export function requiredGuestCompanions(receipt: GuestBuildReceipt): readonly { name: string; identity: ArtifactIdentity }[] {
  const { program } = receipt;
  if (program.kind === "single") return [];
  return [{ name: programProfile(program.kind).side, identity: program.side }];
}

export async function verifyGuestCompanions(receipt: GuestBuildReceipt, directory: string): Promise<void> {
  const { program } = receipt;
  if (program.kind === "single") return;
  const side = await Bun.file(join(directory, programProfile(program.kind).side)).bytes();
  verifyProgramSide(program.kind, new WebAssembly.Module(side));
  if ((importedMemory(side)?.shared ?? false) !== (receiptProfile(receipt.profile) === "shared-group")) throw new Error("Companion differs from guest receipt profile");
  if (!("engineOrigin" in receipt)) throw new Error("Missing engine origin receipt");
  verifyProgramReceipt(side, receipt.engineOrigin, receipt.engineOrigin.inputs);
  const identity = artifactIdentity(side);
  if (identity.artifactSha256 !== program.side.artifactSha256 || identity.artifactBytes !== program.side.artifactBytes) throw new Error("Guest receipt does not match paired engine bytes");
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
  if (value.build === "hermes") required.push("hermes-prebuild");
  if (programKindForBuild(value.build) !== "single") required.push("rust-build-std");
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
  for (const [field, length] of [["bunHead", 40], ["bunTree", 40], ["sysrootReceiptSha256", 64], ["sourceManifestSha256", 64]] as const) {
    if (!digest(value[field], length)) throw new Error(`Invalid guest build receipt: ${field}`);
  }
  verifyManifest(value.sourceManifest);
  const profile = receiptProfile(value.profile);
  checkProfile(value.sourceManifest.build, profile);
  if (hash(JSON.stringify(value.sourceManifest)) !== value.sourceManifestSha256) throw new Error("Guest source manifest digest mismatch");
  const sysroot = value.sourceManifest.groups.find(group => group.name === "sysroot");
  if (sysroot?.files.find(file => file.path === "bun-wasm-sysroot.json")?.sha256 !== value.sysrootReceiptSha256) throw new Error("Guest sysroot receipt differs from source manifest");
  if ("quickjs" in value || "artifactSha256" in value || "artifactBytes" in value) throw new Error("Legacy guest receipt fields are not supported");
  const program = parseProgramFiles(value.program, parseArtifactIdentity);
  if (program.core.artifactBytes !== bytes.byteLength || program.core.artifactSha256 !== hash(bytes)) throw new Error("Guest build receipt does not match artifact bytes");
  if (program.kind !== programKindForBuild(value.sourceManifest.build)
    || program.kind !== programKind(new WebAssembly.Module(Uint8Array.from(bytes)))) throw new Error("Guest build/program engine mismatch");
  const groups = WebAssembly.Module.customSections(new WebAssembly.Module(Uint8Array.from(bytes)), "dylink.0").length;
  if (groups > 1 || (groups === 1) !== (profile === "shared-group") || (importedMemory(bytes)?.shared ?? false) !== (profile === "shared-group")) throw new Error("Core differs from guest receipt profile");
  if (program.kind !== "single") {
    const origin = parseProgramReceipt(value.engineOrigin);
    if (inputProfile(origin.inputs) !== profile) throw new Error("Engine origin differs from composed guest profile");
    if (origin.inputs.scope !== program.kind || origin.inputs.contentSha256 !== value.engineInputSha256
      || origin.artifact.artifactSha256 !== program.side.artifactSha256 || origin.artifact.artifactBytes !== program.side.artifactBytes) throw new Error("Guest engine origin/input identity mismatch");
  } else if ("engineOrigin" in value || "engineInputSha256" in value) throw new Error("Single module cannot have engine provenance");
}

if (import.meta.main) {
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot) throw new Error("Source env.sh before building a guest");
  const [command, argument, snapshot, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error("Unexpected guest receipt arguments");
  if (command === "environment") {
    console.log(guestToolEnvironment(root));
  } else if (command === "inputs" && isGuestBuild(argument)) {
    console.log(JSON.stringify(await prepareGuestBuildInputs(sourceOptions(root, sysroot, argument), parseProgramProfile(snapshot))));
  } else if (command === "write" && argument && snapshot) {
    const inputs: unknown = await Bun.file(snapshot).json();
    const bytes = await Bun.file(argument).bytes();
    if (!record(inputs)) throw new Error("Invalid guest build inputs");
    verifyManifest(inputs.sourceManifest);
    const options = sourceOptions(root, sysroot, inputs.sourceManifest.build);
    const fields = await receiptProgram(options, bytes, dirname(argument), receiptProfile(inputs.profile));
    const receipt = { ...inputs, ...fields };
    verifyGuestBuildReceipt(bytes, receipt);
    await writeGuestBuildReceipt(sourceOptions(root, sysroot, receipt.sourceManifest.build), argument, receipt);
  } else {
    throw new Error("Usage: guest-build-receipt.ts environment | inputs BUILD [split|shared-group] | write ARTIFACT INPUTS_FILE");
  }
}
