import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function readRecord(path: string): Record<string, unknown> { const value: unknown = JSON.parse(readFileSync(path, "utf8")); assert(record(value), `Invalid JSON record: ${path}`); return value; }
function absolutePath(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0 && resolve(value) === value && !value.split("/").includes(".."), `Invalid ${label}`);
  return value;
}
function copyVerified(source: string, target: string, expected: string): void {
  assert.equal(hash(source), expected, `Input identity changed: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) copyFileSync(source, target);
  assert.equal(hash(target), expected, `Staged identity changed: ${target}`);
}
function parseHeaders(path: string, expectedCount: number): { path: string; sha256: string }[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert(Array.isArray(value) && value.length === expectedCount, "Header manifest count changed");
  const headers = value.map((entry: unknown) => {
    assert(record(entry) && typeof entry.path === "string" && digest(entry.sha256), "Invalid header manifest entry");
    assert(entry.path.length > 0 && !entry.path.startsWith("/") && entry.path.split("/").every(part => part !== ".." && part !== "." && part !== ""), "Invalid header path");
    return { path: entry.path, sha256: entry.sha256 };
  });
  assert.equal(new Set(headers.map(header => header.path)).size, expectedCount, "Duplicate header path");
  return headers;
}

function admittedInputs(admissionPath: string) {
  const admission = readRecord(admissionPath);
  assert.equal(admission.status, "ADMITTED_FOR_CONTROLLED_N2_INPUTS");
  assert(admission.admitted === true, "N1 parent admission is required");
  assert(record(admission.archive) && digest(admission.archive.sha256) && positiveInteger(admission.archive.bytes));
  assert(record(admission.headers) && digest(admission.headers.manifestSha256) && positiveInteger(admission.headers.count) && digest(admission.headers.confdefsSha256));
  assert(record(admission.profile) && digest(admission.profile.sha256));
  assert(record(admission.qualification) && digest(admission.qualification.sha256));
  assert(record(admission.compiledSource) && typeof admission.compiledSource.head === "string" && /^[0-9a-f]{40}$/.test(admission.compiledSource.head)
    && typeof admission.compiledSource.tree === "string" && /^[0-9a-f]{40}$/.test(admission.compiledSource.tree));
  assert(record(admission.originalAttempt) && admission.originalAttempt.status === "FAILED", "Original N1 failure must be preserved");
  assert(record(admission.originalBuildToolchain) && admission.originalBuildToolchain.originalCompilerProvenanceClaimed === false, "Original compiler provenance is unclaimed");
  return { admission, archive: { path: absolutePath(admission.archive.path, "archive path"), sha256: admission.archive.sha256, bytes: admission.archive.bytes },
    profile: { path: absolutePath(admission.profile.path, "profile path"), sha256: admission.profile.sha256 },
    qualification: { path: absolutePath(admission.qualification.path, "qualification path"), sha256: admission.qualification.sha256 },
    headers: { includeRoot: absolutePath(admission.headers.includeRoot, "include root"), manifest: absolutePath(admission.headers.manifest, "header manifest"),
      manifestSha256: admission.headers.manifestSha256, count: admission.headers.count,
      confdefs: absolutePath(admission.headers.confdefs, "confdefs path"), confdefsSha256: admission.headers.confdefsSha256 } };
}

function inputReceipt(input: ReturnType<typeof admittedInputs>, admissionSha256: string) {
  return { schema: 2, status: "ADMITTED_FOR_CONTROLLED_N2_INPUTS", parentAdmission: true, admissionSha256,
    source: input.admission.compiledSource, qualification: input.admission.qualification,
    originalAttempt: input.admission.originalAttempt, originalBuildToolchain: input.admission.originalBuildToolchain,
    archive: { path: "libspidermonkey_bunwasm.a", bytes: input.archive.bytes, sha256: input.archive.sha256 },
    profile: { path: "native-profile.json", sha256: input.profile.sha256 },
    headers: { count: input.headers.count, manifestSha256: input.headers.manifestSha256, confdefsSha256: input.headers.confdefsSha256 } };
}

export function verifyEngineInputs(target: string): void {
  const receipt = readRecord(join(target, "native-inputs.json"));
  if (receipt.schema === 3) {
    verifyFreshEngineInputs(target, receipt);
    return;
  }
  const admissionPath = join(target, "parent-admission.json");
  const input = admittedInputs(admissionPath);
  const origin = readRecord(join(target, "native-inputs.json"));
  assert.deepEqual(origin, inputReceipt(input, hash(admissionPath)), "Staged provenance differs from parent admission");
  const archive = join(target, "libspidermonkey_bunwasm.a");
  assert.equal(hash(archive), input.archive.sha256);
  assert.equal(statSync(archive).size, input.archive.bytes);
  assert.equal(hash(join(target, "qualification.json")), input.qualification.sha256);
  assert.equal(hash(join(target, "native-profile.json")), input.profile.sha256);
  assert.equal(hash(join(target, "headers.json")), input.headers.manifestSha256);
  assert.equal(hash(join(target, "js-confdefs.h")), input.headers.confdefsSha256);
  const headers = parseHeaders(join(target, "headers.json"), input.headers.count);
  for (const header of headers) assert.equal(hash(join(target, "include", header.path)), header.sha256);
}

function freshLibrary(target: string) {
  const library = readRecord(join(target, "fresh-library.json"));
  assert.equal(library.gate, "N1");
  assert.equal(library.revision, "a5df22d986d4b626f771b4f8885241941601c35c");
  assert.equal(library.target, "wasm32-unknown-wasip1");
  assert(digest(library.sha256) && positiveInteger(library.bytes));
  assert(record(library.headers) && positiveInteger(library.headers.count) && digest(library.headers.sha256));
  assert(digest(library.confdefsSha256) && digest(library.configureStatusSha256) && digest(library.mozconfigSha256));
  assert(record(library.profile) && library.profile.jit === false && library.profile.sharedMemory === false && library.profile.intlApi === false);
  for (const name of ["exceptionTagSections", "exceptionTagImports", "nonPicCodeRelocations", "absoluteLibcStateRelocations"]) assert.equal(library[name], 0, `Invalid ${name}`);
  assert.equal(library.rustStaticlibIncluded, false);
  assert(record(library.source) && typeof library.source.commit === "string" && /^[0-9a-f]{40}$/.test(library.source.commit)
    && typeof library.source.tree === "string" && /^[0-9a-f]{40}$/.test(library.source.tree));
  assert(Array.isArray(library.recipeInputs) && library.recipeInputs.length > 0 && Array.isArray(library.toolchain) && library.toolchain.length > 0);
  const profile = readRecord(join(target, "native-profile.json"));
  for (const key of Object.keys(profile)) assert.deepEqual(library[key], profile[key], `Fresh profile differs: ${key}`);
  return { library, archive: { path: "libspidermonkey_bunwasm.a", bytes: library.bytes, sha256: library.sha256 },
    headers: { count: library.headers.count, manifestSha256: library.headers.sha256, confdefsSha256: library.confdefsSha256 },
    source: { head: library.source.commit, tree: library.source.tree } };
}

function freshReceipt(target: string) {
  const input = freshLibrary(target);
  return { schema: 3, status: "BUILT_FROM_RECIPE", origin: { kind: "fresh-library", receiptSha256: hash(join(target, "fresh-library.json")) },
    source: input.source, archive: input.archive, headers: input.headers,
    profile: { path: "native-profile.json", sha256: hash(join(target, "native-profile.json")) } };
}

function verifyFreshEngineInputs(target: string, receipt: Record<string, unknown>): void {
  assert.deepEqual(receipt, freshReceipt(target), "Staged provenance differs from fresh library");
  const input = freshLibrary(target);
  assert.equal(hash(join(target, input.archive.path)), input.archive.sha256);
  assert.equal(statSync(join(target, input.archive.path)).size, input.archive.bytes);
  assert.equal(hash(join(target, "headers.json")), input.headers.manifestSha256);
  assert.equal(hash(join(target, "js-confdefs.h")), input.headers.confdefsSha256);
  const headers = parseHeaders(join(target, "headers.json"), input.headers.count);
  for (const header of headers) assert.equal(hash(join(target, "include", header.path)), header.sha256);
}

export function prepareFreshEngineInputs(build: string, target: string): void {
  const receipt = readRecord(join(build, "receipt/vm-library.json"));
  assert(digest(receipt.sha256) && record(receipt.headers) && digest(receipt.headers.sha256) && positiveInteger(receipt.headers.count) && digest(receipt.confdefsSha256));
  copyVerified(join(build, "receipt/vm-library.json"), join(target, "fresh-library.json"), hash(join(build, "receipt/vm-library.json")));
  copyVerified(join(build, "receipt/native-profile.json"), join(target, "native-profile.json"), hash(join(build, "receipt/native-profile.json")));
  copyVerified(join(build, "libspidermonkey_bunwasm.a"), join(target, "libspidermonkey_bunwasm.a"), receipt.sha256);
  copyVerified(join(build, "receipt/headers.json"), join(target, "headers.json"), receipt.headers.sha256);
  copyVerified(join(build, "obj/js/src/js-confdefs.h"), join(target, "js-confdefs.h"), receipt.confdefsSha256);
  const headers = parseHeaders(join(target, "headers.json"), receipt.headers.count);
  for (const header of headers) copyVerified(join(build, "obj/dist/include", header.path), join(target, "include", header.path), header.sha256);
  const bytes = JSON.stringify(freshReceipt(target), null, 2) + "\n";
  const path = join(target, "native-inputs.json");
  if (existsSync(path)) assert.equal(readFileSync(path, "utf8"), bytes, "Existing input receipt must not be relabeled");
  else writeFileSync(path, bytes, { flag: "wx" });
  verifyEngineInputs(target);
}

export function prepareEngineInputs(admissionPath: string, target: string): void {
  const input = admittedInputs(admissionPath);
  const headers = parseHeaders(input.headers.manifest, input.headers.count);
  const admissionSha256 = hash(admissionPath);
  copyVerified(admissionPath, join(target, "parent-admission.json"), admissionSha256);
  copyVerified(input.qualification.path, join(target, "qualification.json"), input.qualification.sha256);
  copyVerified(input.archive.path, join(target, "libspidermonkey_bunwasm.a"), input.archive.sha256);
  assert.equal(statSync(join(target, "libspidermonkey_bunwasm.a")).size, input.archive.bytes);
  copyVerified(input.profile.path, join(target, "native-profile.json"), input.profile.sha256);
  copyVerified(input.headers.manifest, join(target, "headers.json"), input.headers.manifestSha256);
  copyVerified(input.headers.confdefs, join(target, "js-confdefs.h"), input.headers.confdefsSha256);
  for (const header of headers) copyVerified(join(input.headers.includeRoot, header.path), join(target, "include", header.path), header.sha256);
  const receipt = JSON.stringify(inputReceipt(input, admissionSha256), null, 2) + "\n";
  const receiptPath = join(target, "native-inputs.json");
  if (existsSync(receiptPath)) assert.equal(readFileSync(receiptPath, "utf8"), receipt, "Existing N2 input receipt must not be relabeled");
  else writeFileSync(receiptPath, receipt, { flag: "wx" });
  verifyEngineInputs(target);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fresh = args[0] === "--fresh-library";
  const [input, target] = fresh ? args.slice(1) : args;
  assert(input && target, "Usage: prepare-engine-inputs.ts [--fresh-library] INPUT TARGET");
  if (fresh) prepareFreshEngineInputs(resolve(input), resolve(target));
  else prepareEngineInputs(resolve(input), resolve(target));
}
