import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const C1_SOURCE = {
  baseHead: "bdbac44b3e078d29a940232ca23971e44786fc4b",
  baseTree: "230939d6d9706d743d439dd909b89e3e79913ade",
  head: "ffbccf9a4bdf9628a75d751b0160ce79ba842ce0",
  tree: "27e95136c2e3ee91897c206b96184c2cef5fa55b",
} as const;

export const C1_TUPLE = {
  runtime: "0.0.109",
  runtimeArchiveBytes: 2_322_914,
  runtimeArchiveSha256: "874314dbfb2263b5fa5ffc1d04a668440fe0fb2999d50567deee3c46cebb9302",
  relay: "0.0.109",
  relayArchiveBytes: 102_556,
  relayArchiveSha256: "83e429364a8115f445e3ef8c13d601920f45e007f9b83e054c5e34a07c483538",
  programs: "programs-v0.0.15",
  programManifestBytes: 616_752,
  programManifestSha256: "ce29ce655d6de6658d859d3d3fcfcf0d3bc383a2824c462ad0daddec8707a270",
  programManifestSchema: "waffle-program-release/2",
  hostInterface: 1,
} as const;

export const C1_FD3 = {
  artifactPath: "/work/reports/wave-20261101/network/C1/compiled-fd3-20261102/preview1-relay.fd3.wasm",
  artifactBytes: 484,
  artifactSha256: "8bd7e6a507c089fda3b3aa96409da25fc56c87c4baa242cb7f984be0519a80e7",
  receiptPath: "/work/reports/wave-20261101/network/C1/compiled-fd3-20261102/RECEIPT.json",
  receiptBytes: 3_157,
  receiptSha256: "3a1b10247e9e9df338c97dd53b51aa07b3e41d2424669b879b29ea76048df80c",
  owner: "Waffle network coordinator",
  kind: "new-compiled-fd3-fixture-artifact",
  fd: 3,
} as const;

export const C1_REQUIRED_SOURCE_PATHS = [
  { path: "Cargo.toml", kind: "file" },
  { path: "Cargo.lock", kind: "file" },
  { path: "package.json", kind: "file" },
  { path: "bun.lock", kind: "file" },
  { path: "scripts/sync-bun.sh", kind: "file" },
  { path: "scripts/sync-crypto.sh", kind: "file" },
  { path: "vendor/bun/.git", kind: "git" },
  { path: "vendor/bun/src", kind: "directory" },
  { path: "vendor/bun/Cargo.toml", kind: "file" },
  { path: "vendor/bun/Cargo.lock", kind: "file" },
  { path: "vendor/bun/vendor/lol-html", kind: "directory" },
  { path: "vendor/bun/vendor/rust-argon2", kind: "directory" },
  { path: "vendor/bun/build/debug/codegen/build_options.rs", kind: "file" },
  { path: "vendor/boringssl/CMakeLists.txt", kind: "file" },
  { path: "vendor/boringssl/cmake", kind: "directory" },
  { path: "vendor/boringssl/include", kind: "directory" },
  { path: "vendor/boringssl/crypto", kind: "directory" },
  { path: "vendor/boringssl/gen", kind: "directory" },
  { path: "vendor/boringssl/third_party", kind: "directory" },
  { path: "vendor/boringssl/util", kind: "directory" },
  { path: "vendor/boringssl/decrepit", kind: "directory" },
  { path: "third_party/zlib-ng", kind: "directory" },
] as const;

type SourcePathKind = (typeof C1_REQUIRED_SOURCE_PATHS)[number]["kind"];

export interface SourceIdentity {
  readonly head: string;
  readonly tree: string;
}

export interface RequiredPath {
  readonly path: string;
  readonly kind: SourcePathKind;
}

export interface FileIdentity {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DependencyCopy {
  readonly source: string;
  readonly destination: string;
  readonly kind: "file" | "directory";
  readonly bytes?: number;
  readonly sha256?: string;
}

export interface ToolIdentity {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface GitTreeIdentity {
  readonly path: string;
  readonly head: string;
  readonly tree: string;
}

export interface C1PreflightConfig {
  readonly sourceRoot: string;
  readonly source: SourceIdentity;
  readonly requiredPaths?: readonly RequiredPath[];
  readonly dependencyCopies?: readonly DependencyCopy[];
  readonly vendoredTrees?: readonly GitTreeIdentity[];
  readonly submodules?: readonly GitTreeIdentity[];
  readonly receipt?: {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly owner: string;
    readonly kind: string;
    readonly fd: number;
    readonly artifactPath: string;
    readonly artifactBytes: number;
    readonly artifactSha256: string;
  };
  readonly runtime?: FileIdentity;
  readonly relay?: FileIdentity;
  readonly programs?: FileIdentity & { readonly manifestSchema: string; readonly version: string };
  readonly interfaceVersion?: number;
  readonly tools?: readonly ToolIdentity[];
  readonly helpers?: readonly ToolIdentity[];
}

export interface C1PreflightResult {
  readonly source: SourceIdentity;
  readonly receipt: FileIdentity;
  readonly artifact: FileIdentity;
  readonly runtime: FileIdentity;
  readonly relay: FileIdentity;
  readonly programs: FileIdentity;
  readonly copied: readonly string[];
}

export function c1DependencyCopyInventory(sourceRoot: string, privateRoot: string): readonly DependencyCopy[] {
  const roots = ["vendor/bun", "vendor/boringssl", "third_party/zlib-ng"];
  const copy = (path: string): DependencyCopy => ({ source: resolve(sourceRoot, path), destination: resolve(privateRoot, path), kind: "directory" });
  return roots.map(copy);
}

function fail(message: string): never {
  throw new Error(`C1 producer preflight failed: ${message}`);
}

function assertHex(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256`);
}

export function fileIdentity(path: string): FileIdentity {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`missing file ${path}`);
  const bytes = readFileSync(path);
  return identityFromBytes(path, bytes);
}

function identityFromBytes(path: string, bytes: Uint8Array): FileIdentity {
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function assertIdentity(spec: FileIdentity, label: string): FileIdentity {
  assertHex(spec.sha256, `${label}.sha256`);
  const actual = fileIdentity(spec.path);
  if (actual.bytes !== spec.bytes || actual.sha256 !== spec.sha256) fail(`${label} identity mismatch`);
  return actual;
}

export function assertRequiredPath(root: string, entry: RequiredPath): void {
  const path = join(root, entry.path);
  if (!existsSync(path) && !lstatSync(path, { throwIfNoEntry: false })) fail(`missing required ${entry.kind} ${entry.path}`);
  const stat = lstatSync(path);
  if (entry.kind === "file" && !stat.isFile()) fail(`required file is not a file: ${entry.path}`);
  if (entry.kind === "directory" && !stat.isDirectory()) fail(`required directory is not a directory: ${entry.path}`);
  if (entry.kind === "git" && !stat.isDirectory() && !stat.isFile()) fail(`required git entry is absent: ${entry.path}`);
}

export function validateSourceIdentity(actual: SourceIdentity, expected: typeof C1_SOURCE = C1_SOURCE): SourceIdentity {
  if (actual.head !== expected.head || actual.tree !== expected.tree) fail(`source is ${actual.head}/${actual.tree}, expected ${expected.head}/${expected.tree}`);
  return actual;
}

function readSourceIdentity(root: string): SourceIdentity {
  const git = (arg: string) => execFileSync("git", ["-C", root, "rev-parse", arg], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" })) fail("source checkout is dirty");
  const submodules = execFileSync("git", ["-C", root, "submodule", "status", "--recursive"], { encoding: "utf8" });
  if (submodules.split("\n").some(line => /^[+-U]/.test(line))) fail("source submodule is missing or differs from the recorded commit");
  return { head: git("HEAD"), tree: git("HEAD^{tree}") };
}

function validateGitTrees(root: string, label: string, values: readonly GitTreeIdentity[] | undefined): void {
  if (!values?.length) fail(`${label} inventory is missing`);
  for (const value of values) {
    const repository = join(root, value.path);
    if (!existsSync(repository)) fail(`missing ${label} ${value.path}`);
    const git = (arg: string) => execFileSync("git", ["-C", repository, "rev-parse", arg], { encoding: "utf8" }).trim();
    if (git("HEAD") !== value.head || git("HEAD^{tree}") !== value.tree) fail(`${label} identity mismatch for ${value.path}`);
    if (execFileSync("git", ["-C", repository, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" })) fail(`${label} checkout is dirty: ${value.path}`);
  }
}

export function validateRequiredPaths(root: string, required: readonly RequiredPath[]): void {
  for (const entry of required) assertRequiredPath(root, entry);
}

export function validateReceipt(config: C1PreflightConfig, strict = false): { receipt: FileIdentity; artifact: FileIdentity } {
  if (!config.receipt) fail("receipt inventory is missing");
  const expected = config.receipt;
  const admitted = expected.path === C1_FD3.receiptPath && expected.bytes === C1_FD3.receiptBytes && expected.sha256 === C1_FD3.receiptSha256
    && expected.owner === C1_FD3.owner && expected.kind === C1_FD3.kind && expected.fd === C1_FD3.fd
    && expected.artifactPath === C1_FD3.artifactPath && expected.artifactBytes === C1_FD3.artifactBytes && expected.artifactSha256 === C1_FD3.artifactSha256;
  if (strict && !admitted) fail("Network receipt inventory is not the admitted C1 fd3 tuple");
  if (!existsSync(expected.path) || !statSync(expected.path).isFile()) fail(`missing file ${expected.path}`);
  const receiptBytes = readFileSync(expected.path);
  const receipt = identityFromBytes(expected.path, receiptBytes);
  if (receipt.bytes !== expected.bytes || receipt.sha256 !== expected.sha256) fail("Network receipt identity mismatch");
  const parsed: unknown = JSON.parse(receiptBytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object") fail("Network receipt is not an object");
  const value = parsed as Record<string, unknown>;
  if (value.owner !== expected.owner || value.kind !== expected.kind) fail("Network receipt owner or kind mismatch");
  const contract = value.fd3Contract;
  if (!contract || typeof contract !== "object" || (contract as Record<string, unknown>).fd !== expected.fd) fail("Network fd3 contract mismatch");
  const artifact = value.artifact;
  if (!artifact || typeof artifact !== "object") fail("Network receipt artifact metadata is missing");
  const artifactValue = artifact as Record<string, unknown>;
  if (artifactValue.path !== expected.artifactPath || artifactValue.bytes !== expected.artifactBytes || artifactValue.sha256 !== expected.artifactSha256) fail("Network receipt artifact metadata mismatch");
  const artifactIdentity = assertIdentity({ path: expected.artifactPath, bytes: expected.artifactBytes, sha256: expected.artifactSha256 }, "fd3 artifact");
  return { receipt, artifact: artifactIdentity };
}

export function validateTools(label: string, values: readonly ToolIdentity[] | undefined): void {
  if (!values?.length) fail(`${label} inventory is missing`);
  for (const tool of values) assertIdentity(tool, `${label} ${tool.name}`);
}

function validateArchive(label: string, value: FileIdentity | undefined): FileIdentity {
  if (!value) fail(`${label} archive inventory is missing`);
  return assertIdentity(value, label);
}

export function validateC1Preflight(config: C1PreflightConfig): C1PreflightResult {
  const sourceRoot = resolve(config.sourceRoot);
  validateSourceIdentity(config.source, C1_SOURCE);
  validateSourceIdentity(readSourceIdentity(sourceRoot), C1_SOURCE);
  validateRequiredPaths(sourceRoot, config.requiredPaths ?? C1_REQUIRED_SOURCE_PATHS);
  validateGitTrees(sourceRoot, "vendored tree", config.vendoredTrees);
  if (config.submodules) validateGitTrees(sourceRoot, "submodule", config.submodules);
  const network = validateReceipt(config, true);
  const runtime = validateArchive("runtime", config.runtime);
  const relay = validateArchive("relay", config.relay);
  const programs = validateArchive("programs", config.programs);
  if (runtime.bytes !== C1_TUPLE.runtimeArchiveBytes || runtime.sha256 !== C1_TUPLE.runtimeArchiveSha256) fail("runtime archive is not the admitted C1 release");
  if (relay.bytes !== C1_TUPLE.relayArchiveBytes || relay.sha256 !== C1_TUPLE.relayArchiveSha256) fail("relay archive is not the admitted C1 release");
  if (config.programs?.bytes !== C1_TUPLE.programManifestBytes || config.programs.sha256 !== C1_TUPLE.programManifestSha256
    || config.programs.manifestSchema !== C1_TUPLE.programManifestSchema || config.programs.version !== C1_TUPLE.programs) fail("program manifest metadata mismatch");
  if (config.interfaceVersion !== C1_TUPLE.hostInterface) fail("host interface metadata mismatch");
  validateTools("toolchain", config.tools);
  validateTools("helper", config.helpers);
  return { source: config.source, receipt: network.receipt, artifact: network.artifact, runtime, relay, programs, copied: [] };
}

export function prepareC1PrivateRoot(config: C1PreflightConfig, result = validateC1Preflight(config)): C1PreflightResult {
  if (!config.dependencyCopies?.length) fail("dependency copy inventory is missing");
  for (const copy of config.dependencyCopies) validateDependencyCopy(copy);
  const copied: string[] = [];
  for (const copy of config.dependencyCopies) {
    cpSync(copy.source, copy.destination, { recursive: copy.kind === "directory", force: false, errorOnExist: true });
    copied.push(copy.destination);
  }
  return { ...result, copied };
}

function validateDependencyCopy(copy: DependencyCopy): void {
  if (!isAbsolute(copy.source) || !isAbsolute(copy.destination)) fail("dependency copy paths must be absolute");
  if (copy.kind === "file") {
    if (copy.bytes === undefined || copy.sha256 === undefined) fail(`dependency file identity is missing: ${copy.source}`);
    assertIdentity({ path: copy.source, bytes: copy.bytes, sha256: copy.sha256 }, `dependency ${copy.source}`);
    return;
  }
  if (!existsSync(copy.source) || !statSync(copy.source).isDirectory()) fail(`missing dependency directory ${copy.source}`);
}

function isC1PreflightConfig(value: object): value is C1PreflightConfig {
  if (!("sourceRoot" in value) || typeof value.sourceRoot !== "string") return false;
  if (!("source" in value) || !value.source || typeof value.source !== "object") return false;
  return "head" in value.source && typeof value.source.head === "string" && "tree" in value.source && typeof value.source.tree === "string";
}

export function parseC1PreflightConfig(value: unknown): C1PreflightConfig {
  if (!value || typeof value !== "object" || !isC1PreflightConfig(value)) fail("config source identity is missing");
  return value;
}

if (import.meta.main) {
  const [configPath, mode = "check"] = process.argv.slice(2);
  if (!configPath || !["check", "prepare"].includes(mode)) throw new Error("Usage: bun scripts/c1-producer-preflight.ts CONFIG.json [check|prepare]");
  const config = parseC1PreflightConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const result = mode === "prepare" ? prepareC1PrivateRoot(config) : validateC1Preflight(config);
  process.stdout.write(`${JSON.stringify({ status: "passed", ...result }, null, 2)}\n`);
}
