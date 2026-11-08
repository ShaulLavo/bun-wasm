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
  const [admission, target] = process.argv.slice(2);
  assert(admission && target, "Usage: prepare-engine-inputs.ts PARENT-NATIVE-BYTE-ADMISSION.json TARGET");
  prepareEngineInputs(resolve(admission), resolve(target));
}
