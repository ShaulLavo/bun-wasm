import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { verifyGuestBuildReceipt } from "./guest-build-receipt.ts";
import { parseProgramFiles, programKind, verifyProgramSide, type ProgramFiles, type Engine } from "../src/engine-kind.ts";

// Measurement labels, not another engine-kind registry. PBL shares the interpreter program.
export const nativeArmLabels = ["quickjs", "jsc", "spidermonkey-interp", "spidermonkey-pbl"] as const;
type NativeArmLabel = typeof nativeArmLabels[number];
export type ArmLabel = NativeArmLabel | "browser";
export type MeasurementHost = "native" | "chromium";
export const labelsForHost = (host: MeasurementHost): readonly ArmLabel[] => host === "native" ? nativeArmLabels : Array.from<ArmLabel>(nativeArmLabels).concat(["browser"]);
const tierKey = "BUN_WASM_SPIDERMONKEY_TIER";
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface FileIdentity { readonly path: string; readonly bytes: number; readonly sha256: string }
interface SourceIdentity { readonly sourceCommit: string; readonly sourceTree: string }
export interface Admission { readonly admitted: true; readonly manifest: FileIdentity; readonly receipt: FileIdentity }
export interface ArmDescriptor extends SourceIdentity {
  readonly label: ArmLabel;
  readonly engineKind: Engine;
  readonly tier: "interp" | "pbl" | null;
  readonly native: boolean;
  readonly chromium: true;
  readonly environment: Readonly<Record<string, string>>;
  readonly program: ProgramFiles<FileIdentity>;
  readonly servedGzip: ProgramFiles<FileIdentity>;
  readonly coreSha256: string;
  readonly sideSha256: string | null;
  readonly guestSha256: string;
  readonly servedGzipSha256: string;
  readonly producerAdmission: Admission;
}
interface BrowserReceipt extends SourceIdentity {
  readonly schemaVersion: 1;
  readonly engineKind: "browser";
  readonly profile: "browser-single";
  readonly buildScript: "scripts/build-bun-browser.sh";
  readonly buildReceipt: FileIdentity;
  readonly guest: FileIdentity;
  readonly servedGzip: FileIdentity;
  readonly producerAdmission: Admission;
}
export interface ArmRegistry extends SourceIdentity {
  readonly schemaVersion: 2;
  readonly evidence: "producer" | "synthetic";
  readonly nativeRounds: number;
  readonly chromiumRounds: number;
  readonly nativeArms: readonly ArmDescriptor[];
  readonly chromiumArms: readonly ArmDescriptor[];
  readonly browserReceipt: BrowserReceipt;
  readonly launcher: FileIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "expected object, not null");
  return value;
}
function digest(value: unknown, pattern = /^[a-f0-9]{64}$/): string {
  assert.ok(typeof value === "string" && pattern.test(value), "invalid byte/source identity");
  return value;
}
function source(value: Record<string, unknown>): SourceIdentity {
  return { sourceCommit: digest(value.sourceCommit, /^[a-f0-9]{40}$/), sourceTree: digest(value.sourceTree, /^[a-f0-9]{40}$/) };
}
function parseFileIdentity(value: unknown): FileIdentity {
  const file = object(value);
  assert.ok(typeof file.path === "string" && isAbsolute(file.path) && resolve(file.path) === file.path && !file.path.includes("\0"), "artifact path must be absolute");
  assert.ok(typeof file.bytes === "number" && Number.isSafeInteger(file.bytes) && file.bytes > 0, "artifact byte count must be positive");
  return { path: file.path, bytes: file.bytes, sha256: digest(file.sha256) };
}
function admission(value: unknown): Admission {
  const entry = object(value);
  assert.equal(entry.admitted, true, "unadmitted artifacts cannot enter measurement");
  return { admitted: true, manifest: parseFileIdentity(entry.manifest), receipt: parseFileIdentity(entry.receipt) };
}
function measurementKind(program: ProgramFiles<unknown>): Engine { return program.kind === "single" ? "browser" : program.kind; }
function parseLabel(value: unknown): ArmLabel {
  const label = labelsForHost("chromium").find(label => label === value);
  assert.ok(label, "unknown or retired arm label");
  return label;
}
function parseArm(value: unknown, expected: SourceIdentity): ArmDescriptor {
  const entry = object(value);
  const label = parseLabel(entry.label);
  assert.deepEqual(source(entry), expected, "mixed-source arm");
  const program = parseProgramFiles(entry.program, parseFileIdentity);
  const servedGzip = parseProgramFiles(entry.servedGzip, parseFileIdentity);
  const engineKind = measurementKind(program);
  const tier = label === "spidermonkey-interp" ? "interp" : label === "spidermonkey-pbl" ? "pbl" : null;
  assert.equal(engineKind, tier ? "spidermonkey" : label, "label does not match program engine");
  assert.equal(entry.engineKind, engineKind, "engineKind differs from program");
  assert.equal(servedGzip.kind, program.kind, "gzip program kind differs");
  assert.equal(entry.tier, tier, "wrong tier");
  assert.equal(entry.native, label !== "browser", "Browser is unavailable natively");
  assert.equal(entry.chromium, true, "missing Chromium arm");
  const environment: Record<string, string> = tier ? { [tierKey]: tier } : {};
  assert.deepEqual(entry.environment, environment, "only the arm's per-child tier environment is allowed");
  const sideSha256 = program.kind === "single" ? null : program.side.sha256;
  assert.equal(entry.coreSha256, program.core.sha256, "core identity differs");
  assert.equal(entry.sideSha256, sideSha256, "side identity differs");
  assert.equal(entry.guestSha256, program.core.sha256, "guest identity differs");
  assert.equal(entry.servedGzipSha256, servedGzip.core.sha256, "served identity differs");
  return { ...expected, label, engineKind, tier, native: label !== "browser", chromium: true, environment, program, servedGzip,
    coreSha256: program.core.sha256, sideSha256, guestSha256: program.core.sha256, servedGzipSha256: servedGzip.core.sha256, producerAdmission: admission(entry.producerAdmission) };
}
function parseBrowserReceipt(value: unknown, expected: SourceIdentity): BrowserReceipt {
  const entry = object(value);
  assert.deepEqual(source(entry), expected, "mixed-source Browser receipt");
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.engineKind, "browser");
  assert.equal(entry.profile, "browser-single");
  assert.equal(entry.buildScript, "scripts/build-bun-browser.sh");
  return { ...expected, schemaVersion: 1, engineKind: "browser", profile: "browser-single", buildScript: "scripts/build-bun-browser.sh",
    buildReceipt: parseFileIdentity(entry.buildReceipt), guest: parseFileIdentity(entry.guest), servedGzip: parseFileIdentity(entry.servedGzip), producerAdmission: admission(entry.producerAdmission) };
}
function parseArms(value: unknown, host: MeasurementHost, expected: SourceIdentity): ArmDescriptor[] {
  assert.ok(Array.isArray(value), "missing arms");
  const arms = value.map(entry => parseArm(entry, expected));
  assert.deepEqual(arms.map(arm => arm.label), labelsForHost(host), "all current arms must appear exactly once in canonical order");
  return arms;
}
export function parseArmRegistry(value: unknown): ArmRegistry {
  const entry = object(value);
  assert.equal(entry.schemaVersion, 2, "measurement registry requires schemaVersion 2 after Hermes removal");
  assert.ok(entry.evidence === "producer" || entry.evidence === "synthetic", "declare receipt evidence origin");
  const expected = source(entry);
  const nativeArms = parseArms(entry.nativeArms, "native", expected);
  const chromiumArms = parseArms(entry.chromiumArms, "chromium", expected);
  assert.deepEqual(chromiumArms.slice(0, nativeArms.length), nativeArms, "host descriptors differ");
  const [quickjs, jsc, interp, pbl] = nativeArms;
  assert.ok(quickjs && jsc && interp && pbl);
  assert.deepEqual(interp.program, pbl.program, "SpiderMonkey tiers must have identical core/side bytes and paths");
  assert.deepEqual(interp.servedGzip, pbl.servedGzip, "SpiderMonkey tier gzip bytes differ");
  for (const arm of nativeArms) assert.deepEqual(arm.producerAdmission, quickjs.producerAdmission, "mixed producer generations");
  const browserReceipt = parseBrowserReceipt(entry.browserReceipt, expected);
  const browser = chromiumArms.at(-1)!;
  assert.deepEqual(browser.program, { kind: "single", core: browserReceipt.guest }, "Browser guest differs from receipt");
  assert.deepEqual(browser.servedGzip, { kind: "single", core: browserReceipt.servedGzip }, "Browser gzip differs from receipt");
  assert.deepEqual(browser.producerAdmission, browserReceipt.producerAdmission, "Browser admission differs");
  assert.deepEqual(browserReceipt.producerAdmission, quickjs.producerAdmission, "Browser must share the verified producer closure until its separate authority exists");
  assertBalancedRounds(entry.nativeRounds, nativeArms.length);
  assertBalancedRounds(entry.chromiumRounds, chromiumArms.length);
  return { ...expected, schemaVersion: 2, evidence: entry.evidence, nativeRounds: entry.nativeRounds, chromiumRounds: entry.chromiumRounds,
    nativeArms, chromiumArms, browserReceipt, launcher: parseFileIdentity(entry.launcher) };
}

// Williams: n shifts for even n, each shift and its reversal for odd n.
export function williamsSchedule<T>(arms: readonly T[]): T[][] {
  assert.ok(arms.length > 0 && new Set(arms).size === arms.length, "schedule requires distinct arms");
  const n = arms.length;
  const first = Array.from({ length: n }, (_, index) => index % 2 === 0 ? index / 2 : n - (index + 1) / 2);
  const rows = Array.from({ length: n }, (_, shift) => first.map(index => arms[(index + shift) % n]!));
  return n % 2 && n > 1 ? rows.concat(rows.map(row => row.toReversed())) : rows;
}
export function assertBalancedRounds(value: unknown, count: number): asserts value is number {
  const block = count % 2 && count > 1 ? count * 2 : count;
  assert.ok(typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value % block === 0, `rounds require complete ${block}-round Williams blocks`);
}
export function childEnvironment(arm: ArmDescriptor, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  delete env[tierKey];
  return { ...env, ...arm.environment };
}
async function verifyFile(file: FileIdentity): Promise<Uint8Array> {
  const bytes = await readFile(file.path);
  assert.equal(bytes.length, file.bytes, `changed byte count: ${file.path}`);
  assert.equal(sha256(bytes), file.sha256, `changed hash: ${file.path}`);
  return bytes;
}
export async function verifyGzip(raw: FileIdentity, gzip: FileIdentity): Promise<void> {
  const [bytes, compressed] = await Promise.all([verifyFile(raw), verifyFile(gzip)]);
  assert.deepEqual(gunzipSync(compressed, { maxOutputLength: raw.bytes }), Buffer.from(bytes), `gzip roundtrip differs: ${gzip.path}`);
}
async function verifyAdmission(proof: Admission, expected: SourceIdentity, evidence: ArmRegistry["evidence"], files: readonly FileIdentity[]): Promise<void> {
  assert.equal(proof.manifest.path, resolve(dirname(proof.manifest.path), "manifest.json"), "admission must name the canonical producer manifest");
  const [manifestBytes, receiptBytes] = await Promise.all([verifyFile(proof.manifest), verifyFile(proof.receipt)]);
  const manifest = object(JSON.parse(Buffer.from(manifestBytes).toString()));
  const receipt = object(JSON.parse(Buffer.from(receiptBytes).toString()));
  assert.equal(manifest.status, "reusable", "producer manifest is not reusable");
  assert.deepEqual(manifest.source, { head: expected.sourceCommit, tree: expected.sourceTree }, "manifest source differs");
  assert.equal(receipt.kind, "engine-measurement-admission", "missing measurement admission receipt");
  assert.equal(receipt.evidence, evidence, "synthetic receipt is not producer output");
  assert.equal(receipt.admitted, true, "receipt is not admitted");
  assert.equal(receipt.manifestSha256, proof.manifest.sha256, "admission manifest hash differs");
  assert.deepEqual(source(receipt), { sourceCommit: expected.sourceCommit, sourceTree: expected.sourceTree }, "receipt source differs");
  assert.ok(Array.isArray(receipt.files), "missing admitted file identities");
  assert.ok(Array.isArray(manifest.files), "missing producer manifest file identities");
  const recorded = manifest.files.map((value: unknown) => {
    const entry = object(value);
    assert.ok(typeof entry.path === "string" && !isAbsolute(entry.path) && !entry.path.split("/").includes(".."), "invalid manifest file path");
    return parseFileIdentity({ ...entry, path: resolve(dirname(proof.manifest.path), entry.path) });
  });
  assert.equal(new Set(recorded.map(file => file.path)).size, recorded.length, "duplicate manifest file");
  for (const file of files) assert.ok(recorded.some(entry => isDeepStrictEqual(entry, file)), `artifact absent from manifest: ${file.path}`);
  for (const file of files) assert.ok(receipt.files.some((entry: unknown) => isDeepStrictEqual(entry, file)), `artifact absent from admission: ${file.path}`);
}
function programFiles(program: ProgramFiles<FileIdentity>): FileIdentity[] { return program.kind === "single" ? [program.core] : [program.core, program.side]; }
export async function verifyArmRegistry(registry: ArmRegistry, options: { synthetic: boolean } = { synthetic: false }): Promise<void> {
  assert.ok(options.synthetic || registry.evidence === "producer", "synthetic setup receipts cannot authorize measurements");
  await verifyFile(registry.launcher);
  await verifyFile(registry.browserReceipt.buildReceipt);
  for (const arm of registry.chromiumArms) await verifyArm(arm, registry);
}
async function verifyArm(arm: ArmDescriptor, registry: ArmRegistry): Promise<void> {
  await verifyGzip(arm.program.core, arm.servedGzip.core);
  if (arm.program.kind !== "single" && arm.servedGzip.kind !== "single") await verifyGzip(arm.program.side, arm.servedGzip.side);
  await verifyAdmission(arm.producerAdmission, registry, registry.evidence, programFiles(arm.program).concat(programFiles(arm.servedGzip), arm.native ? [registry.launcher] : [registry.browserReceipt.buildReceipt]));
}
export async function loadArmRegistry(path: string): Promise<ArmRegistry> {
  const registry = parseArmRegistry(JSON.parse(await readFile(path, "utf8")));
  await verifyMeasurementInput(registry);
  return registry;
}

// Receipt files are not admission authority by themselves. Re-run the owning
// read-only producer verifier before either CLI executes a measurement.
export async function verifyMeasurementInput(registry: ArmRegistry): Promise<void> {
  await verifyArmRegistry(registry);
  for (const arm of registry.chromiumArms) await verifyArmProgram(arm);
  const receipt: unknown = JSON.parse(Buffer.from(await verifyFile(registry.browserReceipt.buildReceipt)).toString());
  verifyGuestBuildReceipt(await verifyFile(registry.browserReceipt.guest), receipt);
  assert.equal(receipt.sourceManifest.build, "browser", "wrong Browser build receipt");
  assert.deepEqual(receipt.sourceManifest.source, { head: registry.sourceCommit, tree: registry.sourceTree }, "Browser build source differs");
  execFileSync(process.execPath, [resolve(import.meta.dirname, "engine-producer.ts"), "verify", "split"], {
    cwd: resolve(import.meta.dirname, ".."), env: { ...process.env, BUN_WASM_ENGINE_ROOT: dirname(registry.nativeArms[0]!.producerAdmission.manifest.path) }, stdio: "pipe",
  });
  await verifyFile(registry.nativeArms[0]!.producerAdmission.manifest);
}

export async function verifyArmProgram(arm: ArmDescriptor): Promise<void> {
  const core = new WebAssembly.Module(Uint8Array.from(await verifyFile(arm.program.core)));
  assert.equal(programKind(core), arm.program.kind, "actual core engine profile differs from arm label");
  if (arm.program.kind === "single") return;
  const side = new WebAssembly.Module(Uint8Array.from(await verifyFile(arm.program.side)));
  verifyProgramSide(arm.program.kind, side);
}
