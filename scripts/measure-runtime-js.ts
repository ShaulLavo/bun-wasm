import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { programProfile, type PairedEngine } from "../src/engine-kind.ts";
import { producerEngines, requireClosureFiles, verifyLauncher } from "./producer-closure.ts";

export const firstFsSource = `
const now = performance.now.bind(performance);
const start = now();
const fs = require("fs");
const firstRequireMs = now() - start;
const again = now();
const same = require("fs") === fs;
const cachedRequireMs = now() - again;
if (!same || typeof fs.readFileSync !== "function") throw new Error("fs identity or API changed");
console.log("runtime-js-first-fs " + JSON.stringify({ firstRequireMs, cachedRequireMs }));
`;

export function parseFirstFs(stdout: string): { firstRequireMs: number; cachedRequireMs: number } {
  const line = stdout.split("\n").find(line => line.startsWith("runtime-js-first-fs "));
  if (!line) throw new Error("Missing first-fs measurement");
  const value: unknown = JSON.parse(line.slice("runtime-js-first-fs ".length));
  if (typeof value !== "object" || value === null) throw new Error("Invalid first-fs record");
  if (!("firstRequireMs" in value) || !("cachedRequireMs" in value)) throw new Error("Missing first-fs fields");
  const { firstRequireMs, cachedRequireMs } = value;
  if (typeof firstRequireMs !== "number" || !Number.isFinite(firstRequireMs) || firstRequireMs < 0) throw new Error("Invalid first require duration");
  if (typeof cachedRequireMs !== "number" || !Number.isFinite(cachedRequireMs) || cachedRequireMs < 0) throw new Error("Invalid cached require duration");
  return { firstRequireMs, cachedRequireMs };
}

function scopeNumber(fields: Record<string, string>, name: string) {
  const value = Number(fields[name]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid runtime scope ${name}`);
  return value;
}

export function parseRuntimeScopes(stderr: string) {
  const records = stderr.split("\n").filter(line => line.startsWith("[bunwasm:runtime-js] ")).map(line => {
    const fields = Object.fromEntries(Array.from(line.matchAll(/(engine|stage|bytes|id|parent|elapsed_ns|status|scope)=([^ ]+)/g), match => [match[1] ?? "", match[2] ?? ""]));
    if (fields.scope !== "inclusive" || !fields.stage || !fields.engine) throw new Error("Invalid runtime scope");
    const moduleJson = / module=("(?:\\.|[^"\\])*") /.exec(line)?.[1];
    const module: unknown = moduleJson && JSON.parse(moduleJson);
    if (typeof module !== "string") throw new Error("Missing runtime module identity");
    return { engine: fields.engine, stage: fields.stage, module, bytes: scopeNumber(fields, "bytes"), id: scopeNumber(fields, "id"), parent: scopeNumber(fields, "parent"), elapsedNs: scopeNumber(fields, "elapsed_ns") };
  });
  if (records.length === 0) return null;
  const ids = new Set(records.map(record => record.id));
  if (ids.size !== records.length || ids.has(0)) throw new Error("Duplicate or invalid runtime scope id");
  const childTotals = new Map<number, number>();
  for (const record of records) childTotals.set(record.parent, (childTotals.get(record.parent) ?? 0) + record.elapsedNs);
  const exclusiveByStage: Record<string, number> = {};
  for (const record of records) {
    if (record.parent >= record.id || (record.parent !== 0 && !ids.has(record.parent))) throw new Error("Missing runtime scope parent");
    const exclusiveNs = record.elapsedNs - (childTotals.get(record.id) ?? 0);
    if (exclusiveNs < 0) throw new Error("Runtime children exceed their inclusive parent");
    exclusiveByStage[record.stage] = (exclusiveByStage[record.stage] ?? 0) + exclusiveNs;
  }
  return { rootInclusiveNs: records.filter(record => record.parent === 0).reduce((sum, record) => sum + record.elapsedNs, 0), exclusiveByStage, records };
}

function fingerprint(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function sourceIdentity(value: unknown) {
  if (typeof value !== "object" || value === null || !("source" in value)) throw new Error("Missing source identity");
  const source = value.source;
  if (typeof source !== "object" || source === null || !("head" in source) || !("tree" in source)) throw new Error("Invalid source identity");
  if (typeof source.head !== "string" || typeof source.tree !== "string") throw new Error("Invalid source hashes");
  return { head: source.head, tree: source.tree };
}

function artifactRecord(value: unknown) {
  if (typeof value !== "object" || value === null || !("path" in value) || !("bytes" in value) || !("sha256" in value)) throw new Error("Invalid artifact record");
  if (typeof value.path !== "string" || typeof value.bytes !== "number" || typeof value.sha256 !== "string") throw new Error("Invalid artifact fields");
  if (!value.path || value.path.startsWith("/") || value.path.split("/").includes("..")) throw new Error("Unsafe artifact path");
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 };
}

export function verifyMeasurementClosure(directory: string) {
  const unit = resolve(directory);
  if (existsSync(join(unit, ".producer-lock"))) throw new Error("Producer is active; cannot measure a changing closure");
  const manifestPath = join(unit, "manifest.json");
  const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!value || typeof value !== "object" || !("schema" in value) || value.schema !== 1
    || !("status" in value) || value.status !== "reusable" || !("files" in value) || !Array.isArray(value.files)) throw new Error("Invalid reusable producer closure");
  if (!("profile" in value) || value.profile !== "split" || !("engines" in value)
    || !isDeepStrictEqual(value.engines, producerEngines("split"))) throw new Error("Measurement requires the canonical supported paired-engine split closure");
  const files = value.files.map(artifactRecord);
  requireClosureFiles("split", files);
  const artifacts = files.map(file => {
    const actual = fingerprint(join(unit, file.path));
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`Producer artifact changed: ${actual.path}`);
    return actual;
  });
  const source = sourceIdentity(value);
  const launcher = join(unit, "launcher/bun-wasm");
  const receipt = `${launcher}.launcher.json`;
  const verified = verifyLauncher(launcher, JSON.parse(readFileSync(receipt, "utf8")), source);
  if (!("launcher" in value) || !isDeepStrictEqual(value.launcher, { path: launcher, receipt, ...verified })) throw new Error("Manifest launcher differs from its original receipt");
  return { source, manifest: fingerprint(manifestPath), launcher: fingerprint(launcher), launcherReceipt: fingerprint(receipt), artifacts };
}

export function measurementArgs(unit: string, engine: PairedEngine, source: string, enabled: boolean): string[] {
  const optIn = enabled ? ["--env", "BUN_WASM_MEASURE_RUNTIME_JS=1"] : [];
  return ["--wasm", join(unit, "dist", programProfile(engine).core)].concat(optIn, ["--", "-e", source]);
}

function cacheFiles(directory: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += statSync(join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

function main() {
  const [unitArg, outputArg] = process.argv.slice(2);
  if (!unitArg || !outputArg) throw new Error("Usage: measure-runtime-js.ts <original producer unit> <existing output directory>");
  const cache = process.env.BUN_WASM_CACHE_DIR;
  if (!cache || cache === "off" || cache === "0") throw new Error("Set BUN_WASM_CACHE_DIR to an existing shared cache; do not clear it");
  statSync(cache);
  const unit = resolve(unitArg), output = resolve(outputArg);
  statSync(output);
  const closure = verifyMeasurementClosure(unit);
  const launcher = closure.launcher.path;
  const engines = producerEngines("split");
  writeFileSync(join(output, "inputs.json"), JSON.stringify({ ...closure, measurementEnabled: process.env.BUN_WASM_MEASURE_RUNTIME_JS === "1", cache, cacheBefore: cacheFiles(cache), cachePolicy: "Existing shared Wasmtime cache, unchanged policy; cache hits and native compilation time are not attributed" }, null, 2) + "\n");
  for (let repetition = 0; repetition < 3; repetition++) {
    const order = repetition % 2 === 0 ? engines : engines.toReversed();
    for (const engine of order) runPair(unit, launcher, engine, repetition, output);
  }
  writeFileSync(join(output, "cache-after.json"), JSON.stringify(cacheFiles(cache)) + "\n");
}

function runPair(unit: string, launcher: string, engine: PairedEngine, repetition: number, output: string) {
  for (const workload of ["eval1", "first-fs"]) {
    const args = measurementArgs(unit, engine, workload === "eval1" ? "1" : firstFsSource, process.env.BUN_WASM_MEASURE_RUNTIME_JS === "1");
    const start = performance.now();
    const result = spawnSync(launcher, args, { encoding: "utf8", cwd: process.cwd() });
    const wallMs = performance.now() - start;
    const record = { engine, repetition, workload, args, wallMs, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
    writeFileSync(join(output, `${engine}-${repetition}-${workload}.json`), JSON.stringify(record, null, 2) + "\n");
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${engine} ${workload} failed; see raw record`);
    console.log(JSON.stringify({ ...record, firstFs: workload === "first-fs" ? parseFirstFs(result.stdout) : null, runtimeScopes: parseRuntimeScopes(result.stderr) }));
  }
}

if (import.meta.main) main();
