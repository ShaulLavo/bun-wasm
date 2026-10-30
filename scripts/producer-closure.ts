import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";
import { programProfile, type PairedEngine } from "../src/engine-kind.ts";
import type { ProgramProfile } from "./src/program-profile.ts";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export interface ProducerSource { readonly head: string; readonly tree: string }
interface LauncherReceipt {
  readonly source: ProducerSource;
  readonly artifact: { readonly sha256: string; readonly bytes: number };
}
const producerFeatures = ["engine-split", "bun-transpiler", "bun-build"];
const splitEngines: readonly PairedEngine[] = ["quickjs", "jsc", "hermes"];
const groupEngines: readonly PairedEngine[] = ["quickjs"];
export function producerEngines(profile: ProgramProfile): readonly PairedEngine[] {
  return profile === "split" ? splitEngines : groupEngines;
}
export function producerScopes(profile: ProgramProfile): readonly ("core" | PairedEngine)[] {
  const scopes: ("core" | PairedEngine)[] = ["core"];
  return scopes.concat(producerEngines(profile));
}
export function producerSelection(profile: ProgramProfile) {
  return profile === "split" ? { features: producerFeatures } : { features: producerFeatures, profile };
}
export function producerArtifactPaths(profile: ProgramProfile): string[] {
  const engines = producerEngines(profile);
  const paths = ["inputs/programs.json", "core/bun-core.wasm", "core/bun-core.wasm.core.json", "launcher/bun-wasm", "launcher/bun-wasm.launcher.json"];
  return paths.concat(engines.flatMap(engine => {
    const names = programProfile(engine);
    return [`${engine}/engine.wasm`, `${engine}/engine.wasm.engine.json`, `dist/${names.core}`, `dist/${names.core}.build.json`, `dist/${names.side}`, `dist/${names.side}.engine.json`, `${engine}-smoke.log`].concat(profile === "split" ? [`${engine}-node-smoke.log`] : []);
  }), profile === "split" ? ["dist/bun-jsc.wasm.embedding.json", "inputs/hermes-vm.json", "dist/bash-web-shell.wasm", "dist/bash-web-env.wasm", "dist/bash-web-guests.json", "web/index.html", "web/engine-builds.json", "hook-controls.log", "hook-smoke.json"] : ["core/cxx-runtime-members.json", "worker-proof.log"]);
}
export function requireClosureFiles(profile: ProgramProfile, files: readonly { readonly path: string }[]): void {
  const paths = new Set(files.map(file => file.path));
  if (paths.size !== files.length) throw new Error("Repeated producer manifest path");
  for (const path of producerArtifactPaths(profile)) if (!paths.has(path)) throw new Error(`Missing producer manifest artifact: ${path}`);
}
export const workerProofLabels = ["worker-to-main wake", "worker plain store visible in main", "main-to-worker wake", "worker read main's store and answered", "buffer posted on the port aliases", "timed-out", "not-equal", "alias worker exit", "blocked worker started", "terminate cancels a blocked futex wait", "20 sequential members settled", "main still owns the buffer"];
export function verifyWorkerProof(output: string, status: number | null): void {
  const lines = output.split("\n").filter(line => line.startsWith("PASS "));
  if (status !== 0 || /^FAIL /m.test(output) || lines.length !== workerProofLabels.length
    || workerProofLabels.some((label, index) => lines[index] !== `PASS ${label}` && !lines[index]?.startsWith(`PASS ${label} `))) throw new Error("Shared-group worker proof failed");
}
export function launcherReceipt(path: string, source: ProducerSource): LauncherReceipt {
  accessSync(path, constants.X_OK);
  const bytes = readFileSync(path);
  return { source, artifact: { sha256: hash(bytes), bytes: bytes.byteLength } };
}
export function verifyLauncher(path: string, value: unknown, source: ProducerSource): LauncherReceipt {
  if (!value || typeof value !== "object" || !("source" in value) || !("artifact" in value)) throw new Error("Invalid launcher receipt");
  const expected = launcherReceipt(path, source);
  const origin = value.source;
  const artifact = value.artifact;
  if (!origin || typeof origin !== "object" || !("head" in origin) || !("tree" in origin)
    || origin.head !== source.head || origin.tree !== source.tree) throw new Error("Launcher source differs from its original receipt");
  if (!artifact || typeof artifact !== "object" || !("sha256" in artifact) || !("bytes" in artifact)
    || artifact.sha256 !== expected.artifact.sha256 || artifact.bytes !== expected.artifact.bytes) throw new Error("Launcher artifact differs from its original receipt");
  return expected;
}

const shimPath = "crates/bunwasm-hermes/cpp/shim.cpp";
const dependencyPath = "wasi/shim-dependencies.txt";

interface CompilerDependencies { readonly target: string; readonly paths: string[]; readonly valid: boolean }

function compilerDependencyRecord(block: string, directory: string): CompilerDependencies {
  const [header, ...lines] = block.split("\n");
  const match = /^(.+): #deps ([0-9]+), deps mtime [0-9]+ \((VALID|STALE)\)$/.exec(header ?? "");
  if (!match || lines.length !== Number(match[2])) throw new Error("Invalid compiler dependency metadata");
  const paths = lines.map(line => {
    if (!line.startsWith("    ") || line.length === 4) throw new Error("Invalid compiler dependency path");
    return resolve(directory, line.slice(4));
  });
  return { target: resolve(directory, match[1] ?? ""), paths, valid: match[3] === "VALID" };
}

function compilerDependencies(text: string, directory: string, shim: string): CompilerDependencies {
  const records = text.trim().split(/\n\s*\n/).map(block => compilerDependencyRecord(block, directory));
  const matches = records.filter(record => record.paths.includes(shim));
  if (matches.length !== 1) throw new Error("Expected exactly one shim compiler dependency record");
  const record = matches[0];
  if (!record || !record.valid || new Set(record.paths).size !== record.paths.length) throw new Error("Stale or repeated shim compiler dependency record");
  return record;
}

function consumerInput(path: string, repository: string, build: string) {
  const canonical = realpathSync(path);
  const bytes = readFileSync(canonical);
  const repositoryPath = relative(repository, path);
  const buildPath = relative(build, path);
  if (insideRoot(repositoryPath)) return { root: "repository", path: repositoryPath, realPath: canonical, sha256: hash(bytes), bytes: bytes.length };
  if (insideRoot(buildPath)) return { root: "build", path: buildPath, realPath: canonical, sha256: hash(bytes), bytes: bytes.length };
  return { root: "absolute", path, realPath: canonical, sha256: hash(bytes), bytes: bytes.length };
}

function insideRoot(path: string): boolean {
  return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

/** Called only by the original native generation, after the compiler has finished. */
export function hermesConsumerReceipt(repository: string, build: string) {
  repository = realpathSync(repository);
  build = realpathSync(build);
  const shimSource = join(repository, shimPath);
  const metadata = readFileSync(join(build, dependencyPath));
  const dependencies = compilerDependencies(metadata.toString("utf8"), join(build, "wasi"), shimSource);
  const inputs = dependencies.paths.sort().map(path => consumerInput(path, repository, build));
  return {
    shimSource,
    shimSha256: hash(readFileSync(shimSource)),
    consumerInputs: {
      schema: 1,
      roots: { repository, build },
      dependencyMetadata: { path: dependencyPath, sha256: hash(metadata), bytes: metadata.length },
      target: dependencies.target,
      inputs,
    },
  };
}

/** A native archive is never refreshed here; its owner must supply a matching generation. */
export function verifyHermesLibrary(repository: string, build: string, receiptPath: string): void {
  const value: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (!value || typeof value !== "object" || !("sha256" in value) || !("bytes" in value) || !("shimSha256" in value)
    || !("shimSource" in value) || !("consumerInputs" in value)) throw new Error("Hermes VM receipt must identify archive bytes and compiler consumer inputs; a new matching native generation is required");
  const bytes = readFileSync(join(build, "wasi/lib/libhermesvm_bunwasm.a"));
  let current: ReturnType<typeof hermesConsumerReceipt>;
  try { current = hermesConsumerReceipt(repository, build); }
  catch (error) { throw new Error("Hermes compiler consumer inputs unavailable; a new matching native generation is required", { cause: error }); }
  if (value.sha256 !== hash(bytes) || value.bytes !== bytes.byteLength || value.shimSha256 !== current.shimSha256
    || value.shimSource !== current.shimSource || !isDeepStrictEqual(value.consumerInputs, current.consumerInputs)) throw new Error("Hermes archive or compiler consumer inputs changed; a new matching native generation is required");
}
