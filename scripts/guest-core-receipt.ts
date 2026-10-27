import { join, resolve } from "node:path";
import { tagProgramCore, verifyProgramSide, type PairedEngine } from "../src/engine-kind.ts";
import { captureSourceManifest, hash, run, sourceOptions, type ProgramInputScope, type SourceOptions } from "./guest-source-manifest.ts";

export interface ProgramInputSnapshot {
  readonly schema: 1;
  readonly scope: ProgramInputScope;
  readonly source: { readonly head: string; readonly tree: string };
  readonly content: unknown;
  readonly contentSha256: string;
}
export interface ProgramBuildReceipt {
  readonly schema: 1;
  readonly inputs: ProgramInputSnapshot;
  readonly artifact: { readonly artifactSha256: string; readonly artifactBytes: number };
}
const optimizer = ["-O2", "-g", "--strip-dwarf", "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext", "--enable-mutable-globals"];
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const digest = (value: unknown, length: number): value is string => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

export function parseProgramInputs(value: unknown): ProgramInputSnapshot {
  if (!record(value) || value.schema !== 1 || (value.scope !== "core" && value.scope !== "quickjs" && value.scope !== "jsc")
    || !record(value.source) || !digest(value.source.head, 40) || !digest(value.source.tree, 40)
    || !digest(value.contentSha256, 64) || !record(value.content) || hash(JSON.stringify(value.content)) !== value.contentSha256) throw new Error("Invalid program input snapshot");
  return { schema: 1, scope: value.scope, source: { head: value.source.head, tree: value.source.tree }, content: value.content, contentSha256: value.contentSha256 };
}

export function parseProgramReceipt(value: unknown): ProgramBuildReceipt {
  if (!record(value) || value.schema !== 1 || !record(value.artifact) || !digest(value.artifact.artifactSha256, 64)
    || typeof value.artifact.artifactBytes !== "number" || !Number.isSafeInteger(value.artifact.artifactBytes) || value.artifact.artifactBytes < 8) throw new Error("Invalid program build receipt");
  return { schema: 1, inputs: parseProgramInputs(value.inputs), artifact: { artifactSha256: value.artifact.artifactSha256, artifactBytes: value.artifact.artifactBytes } };
}

export function verifyProgramReceipt(bytes: Uint8Array, value: unknown, expected: ProgramInputSnapshot): ProgramBuildReceipt {
  const receipt = parseProgramReceipt(value);
  if (receipt.inputs.scope !== expected.scope || receipt.inputs.contentSha256 !== expected.contentSha256) throw new Error("Program input compatibility mismatch");
  if (receipt.artifact.artifactSha256 !== hash(bytes) || receipt.artifact.artifactBytes !== bytes.byteLength) throw new Error("Program receipt does not match artifact bytes");
  const module = new WebAssembly.Module(Uint8Array.from(bytes));
  if (expected.scope === "core") tagProgramCore(bytes, "quickjs");
  else verifyProgramSide(expected.scope, module);
  return receipt;
}

function coreSelection(value: unknown): { features: string[] } {
  if (!record(value) || Object.keys(value).join() !== "features" || !Array.isArray(value.features) || !value.features.every(item => typeof item === "string")) throw new Error("Invalid common core profile");
  const features: string[] = value.features;
  const key = features.toSorted().join(",");
  if (key !== "engine-split" && key !== "bun-build,bun-transpiler,engine-split") throw new Error("Invalid common core features");
  return { features: features.slice() };
}

export function engineEnvironment(kind: PairedEngine, sysroot: string): Record<string, string> {
  const flags: Record<string, string> = {
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: "-C relocation-model=pic -C panic=abort -C link-self-contained=no",
    CFLAGS_wasm32_wasip1: `--sysroot=${sysroot} -fPIC`,
  };
  if (kind === "jsc") flags.CXXFLAGS_wasm32_wasip1 = `--sysroot=${sysroot} -fPIC -fno-exceptions`;
  else flags.RQUICKJS_SYS_NO_WASI_SDK = "1";
  return flags;
}

export async function captureProgramInputs(options: SourceOptions, scope: ProgramInputScope, selection?: unknown): Promise<ProgramInputSnapshot> {
  if (process.env.RUSTFLAGS !== undefined || process.env.CARGO_ENCODED_RUSTFLAGS !== undefined) throw new Error("Unset ambient RUSTFLAGS and CARGO_ENCODED_RUSTFLAGS for qualified program inputs");
  if (scope === "quickjs" && (process.env.QUICKJS_SMOKE_EXPORTS ?? "0") !== "0") throw new Error("Qualified QuickJS program receipts require QUICKJS_SMOKE_EXPORTS=0");
  run(["bash", join(options.repository, "scripts/sync-bun.sh"), "--check"], options.repository);
  const manifest = await captureSourceManifest(options, scope);
  const selected = scope === "core" ? coreSelection(selection) : { kind: scope };
  const command = scope === "core"
    ? { target: "wasm32-wasip1", release: true, locked: true, offline: true, buildStd: false, optimizer,
      environment: Object.fromEntries(["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS", "CFLAGS_wasm32_wasip1", "CXXFLAGS_wasm32_wasip1"].map(name => [name, process.env[name] ?? ""])) }
    : { target: "wasm32-wasip1", release: true, locked: true, offline: true, buildStd: ["std", "panic_abort"], environment: engineEnvironment(scope, options.sysroot),
      link: ["--shared", "--Bsymbolic", "--no-export-dynamic", "--gc-sections", "--no-entry", "--import-memory=env,memory", "--import-table", "--allow-undefined"], spillPointers: scope === "jsc", smokeExports: false };
  const content = { selection: selected, command, groups: manifest.groups, tools: manifest.tools, omissions: manifest.omissions };
  return { schema: 1, scope, source: manifest.source, content, contentSha256: hash(JSON.stringify(content)) };
}

export async function recaptureProgramInputs(repository: string, sysroot: string, inputs: ProgramInputSnapshot): Promise<ProgramInputSnapshot> {
  const selection = record(inputs.content) ? inputs.content.selection : undefined;
  return captureProgramInputs(sourceOptions(repository, sysroot, inputs.scope === "core" ? "browser" : inputs.scope), inputs.scope, selection);
}

export async function writeProgramReceipt(repository: string, sysroot: string, artifact: string, snapshot: string): Promise<ProgramBuildReceipt> {
  const inputs = parseProgramInputs(await Bun.file(snapshot).json());
  const current = await recaptureProgramInputs(repository, sysroot, inputs);
  if (JSON.stringify(current) !== JSON.stringify(inputs)) throw new Error("Program source or inputs changed during build");
  const bytes = await Bun.file(artifact).bytes();
  const receipt: ProgramBuildReceipt = { schema: 1, inputs, artifact: { artifactSha256: hash(bytes), artifactBytes: bytes.byteLength } };
  verifyProgramReceipt(bytes, receipt, current);
  await Bun.write(`${artifact}.${inputs.scope === "core" ? "core" : "engine"}.json`, JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot) throw new Error("Set BUN_WASM_SYSROOT");
  const [command, path, argument, output] = process.argv.slice(2);
  if (command === "inputs" && path) console.log(JSON.stringify(await captureProgramInputs(sourceOptions(root, sysroot, "browser"), "core", await Bun.file(path).json())));
  else if (command === "write" && path && argument) await writeProgramReceipt(root, sysroot, path, argument);
  else if (command === "verify" && path && argument) {
    const expected = parseProgramInputs(await Bun.file(argument).json());
    if (expected.scope !== "core") throw new Error("Expected common core inputs");
    verifyProgramReceipt(await Bun.file(path).bytes(), await Bun.file(`${path}.core.json`).json(), expected);
  } else if (command === "tag" && path && (argument === "quickjs" || argument === "jsc") && output) {
    const receipt = parseProgramReceipt(await Bun.file(`${path}.core.json`).json());
    const expected = await recaptureProgramInputs(root, sysroot, receipt.inputs);
    const bytes = await Bun.file(path).bytes();
    verifyProgramReceipt(bytes, receipt, expected);
    await Bun.write(output, tagProgramCore(bytes, argument));
  } else throw new Error("Usage: guest-core-receipt.ts inputs PROFILE_JSON_FILE | write CORE SNAPSHOT | verify CORE SNAPSHOT | tag CORE quickjs|jsc OUTPUT");
}
