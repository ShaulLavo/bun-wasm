import { join, resolve } from "node:path";
import { lstatSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isPairedEngine, programKindForBuild, tagProgramCore, verifyProgramSide, type PairedEngine } from "../src/engine-kind.ts";
import { captureSourceManifest, guestBuilds, hash, run, sourceOptions, type ProgramInputScope, type SourceOptions } from "./guest-source-manifest.ts";
import { parseProgramProfile, SHARED_GROUP_OPTIMIZER, SHARED_GROUP_SIDE_LINK, sharedGroupCoreLink, sharedGroupEnvironment, verifySharedSysroot,
  verifySplitSysroot, type ProgramProfile } from "./src/program-profile.ts";

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
  if (!record(value) || value.schema !== 1 || (value.scope !== "core" && !isPairedEngine(value.scope))
    || !record(value.source) || !digest(value.source.head, 40) || !digest(value.source.tree, 40)
    || !digest(value.contentSha256, 64) || !record(value.content) || hash(JSON.stringify(value.content)) !== value.contentSha256) throw new Error("Invalid program input snapshot");
  return { schema: 1, scope: value.scope, source: { head: value.source.head, tree: value.source.tree }, content: value.content, contentSha256: value.contentSha256 };
}

export function parseProgramReceipt(value: unknown): ProgramBuildReceipt {
  if (!record(value) || value.schema !== 1 || !record(value.artifact) || !digest(value.artifact.artifactSha256, 64)
    || typeof value.artifact.artifactBytes !== "number" || !Number.isSafeInteger(value.artifact.artifactBytes) || value.artifact.artifactBytes < 8) throw new Error("Invalid program build receipt");
  return { schema: 1, inputs: parseProgramInputs(value.inputs), artifact: { artifactSha256: value.artifact.artifactSha256, artifactBytes: value.artifact.artifactBytes } };
}

function diagnosticFields(value: unknown): Record<string, unknown> | undefined {
  if (record(value)) return value;
  if (!Array.isArray(value)) return;
  const entries: [string, unknown][] = [];
  for (const item of value) {
    if (!record(item)) return;
    const key = typeof item.name === "string" ? item.name : item.path;
    if (typeof key !== "string") return;
    entries.push([key, item]);
  }
  const fields = Object.fromEntries(entries);
  return Object.keys(fields).length === entries.length ? fields : undefined;
}

interface InputDifference { readonly path: readonly string[]; readonly original: unknown; readonly expected: unknown }
function inputDifferences(original: unknown, expected: unknown, path: readonly string[] = []): InputDifference[] {
  if (JSON.stringify(original) === JSON.stringify(expected)) return [];
  const before = diagnosticFields(original);
  const after = diagnosticFields(expected);
  if (!before || !after) return [{ path, original, expected }];
  const keys = new Set(Object.keys(before).concat(Object.keys(after)));
  const differences = Array.from(keys).flatMap(key => inputDifferences(before[key], after[key], path.concat([key])));
  return differences.length ? differences : [{ path, original, expected }];
}

export function verifyProgramReceipt(bytes: Uint8Array, value: unknown, expected: ProgramInputSnapshot): ProgramBuildReceipt {
  const receipt = parseProgramReceipt(value);
  if (receipt.artifact.artifactSha256 !== hash(bytes) || receipt.artifact.artifactBytes !== bytes.byteLength) throw new Error("Program receipt does not match artifact bytes");
  if (receipt.inputs.scope !== expected.scope) throw new Error("Program input compatibility mismatch");
  // Checked before the digest: a shared-group receipt never stands in for a split one, or the reverse.
  if (inputProfile(receipt.inputs) !== inputProfile(expected)) throw new Error("Program profile mismatch");
  const module = new WebAssembly.Module(Uint8Array.from(bytes));
  if (receipt.inputs.scope === "core") tagProgramCore(bytes, "quickjs");
  else verifyProgramSide(receipt.inputs.scope, module);
  if (receipt.inputs.contentSha256 !== expected.contentSha256) {
    const identity = (inputs: ProgramInputSnapshot) => ({ source: inputs.source, contentSha256: inputs.contentSha256 });
    throw new Error("Program input compatibility mismatch\n" + JSON.stringify({
      original: identity(receipt.inputs), expected: identity(expected), differences: inputDifferences(receipt.inputs.content, expected.content),
    }, null, 2));
  }
  return receipt;
}

/** The profile recorded in program inputs. A split snapshot records none, so its digest is unchanged. */
export function inputProfile(inputs: ProgramInputSnapshot): ProgramProfile {
  return record(inputs.content) && record(inputs.content.selection) ? parseProgramProfile(inputs.content.selection.profile) : "split";
}

type CoreSelection = { readonly features: readonly string[]; readonly profile?: "shared-group" };

function coreSelection(value: unknown): CoreSelection {
  const keys = record(value) ? Object.keys(value).sort().join() : "";
  if (!record(value) || (keys !== "features" && keys !== "features,profile") || !Array.isArray(value.features) || !value.features.every(item => typeof item === "string")) throw new Error("Invalid common core profile");
  const features: string[] = value.features;
  const key = features.toSorted().join(",");
  if (key !== "engine-split" && key !== "bun-build,bun-transpiler,engine-split") throw new Error("Invalid common core features");
  if (keys === "features") return { features: features.slice() };
  if (value.profile !== "shared-group") throw new Error("Invalid common core program profile");
  return { features: features.slice(), profile: "shared-group" };
}

function selectionKey(selection: CoreSelection | { kind: string; profile?: "shared-group" }): string {
  const base = "features" in selection ? selection.features.toSorted().join(",") : selection.kind;
  return selection.profile ? `${base}|${selection.profile}` : base;
}

type ProgramOutputRequest = { readonly artifact: string; readonly options: SourceOptions } & (
  | { readonly scope: "core"; readonly selection: CoreSelection }
  | { readonly scope: PairedEngine; readonly profile?: ProgramProfile }
);

function outputReceiptPath(request: ProgramOutputRequest): string {
  return `${request.artifact}.${request.scope === "core" ? "core" : "engine"}.json`;
}

function outputSelection(inputs: ProgramInputSnapshot): string {
  if (!record(inputs.content)) throw new Error("Invalid program input content");
  const command = inputs.content.command;
  if (!record(command) || command.target !== "wasm32-wasip1" || command.release !== true || command.locked !== true || command.offline !== true) throw new Error("Invalid retained program recipe profile");
  const shared = inputProfile(inputs) === "shared-group";
  const buildStd = inputs.scope === "core" && !shared ? false : ["std", "panic_abort"];
  if (JSON.stringify(command.buildStd) !== JSON.stringify(buildStd)) throw new Error("Invalid retained program standard library profile");
  if (inputs.scope === "core" && JSON.stringify(command.optimizer) !== JSON.stringify(shared ? SHARED_GROUP_OPTIMIZER : optimizer)) throw new Error("Invalid retained core optimizer profile");
  if (inputs.scope !== "core" && (command.smokeExports !== false || command.spillPointers !== (inputs.scope === "jsc"))) throw new Error("Invalid retained engine finalization profile");
  if (shared && ((inputs.scope !== "core" && inputs.scope !== "quickjs") || !record(inputs.content.sharedSysroot))) throw new Error("Invalid retained shared-group inputs");
  const selection = inputs.content.selection;
  if (inputs.scope === "core") return selectionKey(coreSelection(selection));
  if (!record(selection) || Object.keys(selection).sort().join() !== (shared ? "kind,profile" : "kind") || selection.kind !== inputs.scope) throw new Error("Invalid engine input profile");
  return selectionKey({ kind: inputs.scope, profile: shared ? "shared-group" : undefined });
}

async function retainedOutput(request: ProgramOutputRequest): Promise<ProgramBuildReceipt | undefined> {
  const receiptPath = outputReceiptPath(request);
  const artifact = lstatSync(request.artifact, { throwIfNoEntry: false });
  const receiptFile = lstatSync(receiptPath, { throwIfNoEntry: false });
  if (!artifact && !receiptFile) return;
  if (!artifact?.isFile() || !receiptFile?.isFile()) throw new Error(`Partial or non-regular program output: ${request.artifact}`);
  const origin = parseProgramReceipt(await Bun.file(receiptPath).json());
  verifyProgramReceipt(await Bun.file(request.artifact).bytes(), origin, origin.inputs);
  if (origin.inputs.scope !== request.scope) throw new Error("Retained program scope mismatch");
  const expected = request.scope === "core" ? selectionKey(coreSelection(request.selection))
    : selectionKey({ kind: request.scope, profile: request.profile === "shared-group" ? "shared-group" : undefined });
  if (outputSelection(origin.inputs) !== expected) throw new Error("Retained program profile mismatch");
  return origin;
}

/** The composing caller owns retirement, only after every retained output and input is validated. */
export async function prepareProgramOutputs(requests: readonly ProgramOutputRequest[]): Promise<void> {
  const origins = await Promise.all(requests.map(retainedOutput));
  const capture = (request: ProgramOutputRequest) => request.scope === "core"
    ? captureProgramInputs(request.options, request.scope, request.selection)
    : captureProgramInputs(request.options, request.scope, undefined, request.profile);
  const inputs = await Promise.all(requests.map(capture));
  const finished = await Promise.all(requests.map(capture));
  if (JSON.stringify(inputs) !== JSON.stringify(finished)) throw new Error("Program source or inputs changed during output preparation");
  for (const [index, request] of requests.entries()) {
    const origin = origins[index];
    if (!origin || origin.inputs.contentSha256 === inputs[index]?.contentSha256) continue;
    await rm(request.artifact);
    await rm(outputReceiptPath(request));
  }
}

type ComposedBuild = "quickjs" | "quickjs-minimal" | "jsc" | "hermes";
const composedBuilds: readonly ComposedBuild[] = ["quickjs", "quickjs-minimal", "jsc", "hermes"];

async function prepareComposedOutputs(repository: string, sysroot: string, build: ComposedBuild, core: string, side: string): Promise<void> {
  const kind = programKindForBuild(build);
  if (kind === "single") throw new Error(`Not a paired build: ${build}`);
  await prepareProgramOutputs([
    { artifact: core, scope: "core", selection: { features: guestBuilds[build].features }, options: sourceOptions(repository, sysroot, "browser") },
    { artifact: side, scope: kind, options: sourceOptions(repository, sysroot, kind) },
  ]);
}

export function engineEnvironment(kind: PairedEngine, sysroot: string, profile: ProgramProfile = "split"): Record<string, string> {
  if (profile === "shared-group") {
    if (kind !== "quickjs") throw new Error(`shared-group ${kind} is not qualified: its native inputs are not built with atomics`);
    return sharedGroupEnvironment(sysroot, kind);
  }
  const flags: Record<string, string> = {
    CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS: "-C relocation-model=pic -C panic=abort -C link-self-contained=no",
    CFLAGS_wasm32_wasip1: `--sysroot=${sysroot} -fPIC`,
  };
  if (kind === "jsc" || kind === "hermes") flags.CXXFLAGS_wasm32_wasip1 = `--sysroot=${sysroot} -fPIC -fno-exceptions`;
  else flags.RQUICKJS_SYS_NO_WASI_SDK = "1";
  return flags;
}

export async function captureProgramInputs(options: SourceOptions, scope: ProgramInputScope, selection?: unknown, engineProfile: ProgramProfile = "split"): Promise<ProgramInputSnapshot> {
  if (process.env.RUSTFLAGS !== undefined || process.env.CARGO_ENCODED_RUSTFLAGS !== undefined) throw new Error("Unset ambient RUSTFLAGS and CARGO_ENCODED_RUSTFLAGS for qualified program inputs");
  if (scope === "quickjs" && (process.env.QUICKJS_SMOKE_EXPORTS ?? "0") !== "0") throw new Error("Qualified QuickJS program receipts require QUICKJS_SMOKE_EXPORTS=0");
  run(["bash", join(options.repository, "scripts/sync-bun.sh"), "--check"], options.repository);
  const core = scope === "core" ? coreSelection(selection) : undefined;
  const profile = core ? core.profile ?? "split" : engineProfile;
  const sharedSysroot = profile === "shared-group" ? verifySharedSysroot(options.sysroot) : (verifySplitSysroot(options.sysroot), undefined);
  const buildStd = profile === "shared-group";
  const captured = buildStd ? { ...options, rustSourceLib: buildStdSource(options) } : options;
  const manifest = await captureSourceManifest(captured, scope, buildStd);
  if (sharedSysroot) {
    const content = sharedGroupContent(options, scope, manifest, sharedSysroot, core);
    return { schema: 1, scope, source: manifest.source, content, contentSha256: hash(JSON.stringify(content)) };
  }
  const selected = core ?? { kind: scope };
  const command = scope === "core"
    ? { target: "wasm32-wasip1", release: true, locked: true, offline: true, buildStd: false, optimizer,
      environment: Object.fromEntries(["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS", "CFLAGS_wasm32_wasip1", "CXXFLAGS_wasm32_wasip1"].map(name => [name, process.env[name] ?? ""])) }
    : { target: "wasm32-wasip1", release: true, locked: true, offline: true, buildStd: ["std", "panic_abort"], environment: engineEnvironment(scope, options.sysroot),
      link: ["--shared", "--Bsymbolic", "--no-export-dynamic", "--gc-sections", "--no-entry", "--import-memory=env,memory", "--import-table", "--allow-undefined"], spillPointers: scope === "jsc", smokeExports: false };
  const content = { selection: selected, command, groups: manifest.groups, tools: manifest.tools, omissions: manifest.omissions };
  return { schema: 1, scope, source: manifest.source, content, contentSha256: hash(JSON.stringify(content)) };
}

function buildStdSource(options: SourceOptions): string {
  if (options.rustSourceLib) return options.rustSourceLib;
  const rustc = options.tools.rustc;
  if (!rustc) throw new Error("Shared-group inputs need the pinned Rust compiler");
  return join(run([rustc, "--print", "sysroot"], options.repository), "lib/rustlib/src/rust/library");
}

/** Shared-group inputs: the exact flags, link, sysroot identity and profile, never a split field set. */
function sharedGroupContent(options: SourceOptions, scope: ProgramInputScope, manifest: Awaited<ReturnType<typeof captureSourceManifest>>,
  sharedSysroot: ReturnType<typeof verifySharedSysroot>, core: CoreSelection | undefined) {
  if (scope !== "core" && scope !== "quickjs") throw new Error(`shared-group ${scope} is not qualified: its native inputs are not built with atomics`);
  const environment = sharedGroupEnvironment(options.sysroot, scope);
  const recorded = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name] ?? ""]));
  if (JSON.stringify(recorded) !== JSON.stringify(environment)) throw new Error("shared-group build environment differs from its profile");
  const base = { target: "wasm32-wasip1", release: true, locked: true, offline: true, buildStd: ["std", "panic_abort"], environment };
  const command = scope === "core"
    ? { ...base, optimizer: SHARED_GROUP_OPTIMIZER, link: sharedGroupCoreLink(), finalize: "core_initialize_memory" }
    : { ...base, link: SHARED_GROUP_SIDE_LINK, spillPointers: false, smokeExports: false };
  const selection = core ?? { kind: scope, profile: "shared-group" };
  return { selection, sharedSysroot, command, groups: manifest.groups, tools: manifest.tools, omissions: manifest.omissions };
}

export async function recaptureProgramInputs(repository: string, sysroot: string, inputs: ProgramInputSnapshot): Promise<ProgramInputSnapshot> {
  const selection = record(inputs.content) ? inputs.content.selection : undefined;
  return captureProgramInputs(sourceOptions(repository, sysroot, inputs.scope === "core" ? "browser" : inputs.scope), inputs.scope, selection, inputProfile(inputs));
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
  const composed = composedBuilds.find(build => build === path);
  if (command === "inputs" && path) console.log(JSON.stringify(await captureProgramInputs(sourceOptions(root, sysroot, "browser"), "core", await Bun.file(path).json())));
  else if (command === "prepare-core" && path && argument) await prepareProgramOutputs([
    { artifact: argument, scope: "core", selection: coreSelection(await Bun.file(path).json()), options: sourceOptions(root, sysroot, "browser") },
  ]);
  else if (command === "prepare" && composed && argument && output) await prepareComposedOutputs(root, sysroot, composed, argument, output);
  else if (command === "write" && path && argument) await writeProgramReceipt(root, sysroot, path, argument);
  else if (command === "verify" && path && argument) {
    const expected = parseProgramInputs(await Bun.file(argument).json());
    if (expected.scope !== "core") throw new Error("Expected common core inputs");
    verifyProgramReceipt(await Bun.file(path).bytes(), await Bun.file(`${path}.core.json`).json(), expected);
  } else if (command === "tag" && path && isPairedEngine(argument) && output) {
    const receipt = parseProgramReceipt(await Bun.file(`${path}.core.json`).json());
    const expected = await recaptureProgramInputs(root, sysroot, receipt.inputs);
    const bytes = await Bun.file(path).bytes();
    verifyProgramReceipt(bytes, receipt, expected);
    await Bun.write(output, tagProgramCore(bytes, argument));
  } else throw new Error("Usage: guest-core-receipt.ts inputs PROFILE_JSON_FILE | prepare-core PROFILE_JSON_FILE CORE | prepare BUILD CORE SIDE | write CORE SNAPSHOT | verify CORE SNAPSHOT | tag CORE quickjs|jsc|hermes OUTPUT");
}
