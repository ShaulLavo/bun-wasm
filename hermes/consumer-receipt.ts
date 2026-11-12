// Dormant original-generation evidence. Not part of supported publication admission.
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join, relative, resolve } from "node:path";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

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

function compilerRepository(value: unknown): string {
  if (!value || typeof value !== "object" || !("roots" in value)) throw new Error("Missing original compiler roots");
  const roots = value.roots;
  if (!roots || typeof roots !== "object" || !("repository" in roots)
    || typeof roots.repository !== "string" || !isAbsolute(roots.repository)) throw new Error("Invalid original compiler repository");
  return roots.repository;
}

function verifyCurrentHermesConsumer(repository: string, original: ReturnType<typeof hermesConsumerReceipt>): void {
  repository = realpathSync(repository);
  const { roots, inputs } = original.consumerInputs;
  for (const input of inputs) {
    if (input.root !== "repository") continue;
    const current = consumerInput(join(repository, input.path), repository, roots.build);
    const resolved = relative(roots.repository, input.realPath);
    const expectedRealPath = insideRoot(resolved) ? resolve(repository, resolved) : input.realPath;
    if (current.root !== "repository" || current.path !== input.path || current.realPath !== expectedRealPath
      || current.sha256 !== input.sha256 || current.bytes !== input.bytes) throw new Error(`Hermes current compiler consumer input changed: ${input.path}`);
  }
}

/** Recheck original compiler evidence, then bind the current checkout by input content. Never refresh the archive or receipt. */
export function verifyHermesLibrary(repository: string, build: string, receiptPath: string): void {
  const value: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (!value || typeof value !== "object" || !("sha256" in value) || !("bytes" in value) || !("shimSha256" in value)
    || !("shimSource" in value) || !("consumerInputs" in value)) throw new Error("Hermes VM receipt must identify archive bytes and compiler consumer inputs; a new matching native generation is required");
  const bytes = readFileSync(join(build, "wasi/lib/libhermesvm_bunwasm.a"));
  let original: ReturnType<typeof hermesConsumerReceipt>;
  try { original = hermesConsumerReceipt(compilerRepository(value.consumerInputs), build); }
  catch (error) { throw new Error("Hermes compiler consumer inputs unavailable; a new matching native generation is required", { cause: error }); }
  if (value.sha256 !== hash(bytes) || value.bytes !== bytes.byteLength || value.shimSha256 !== original.shimSha256
    || value.shimSource !== original.shimSource || !isDeepStrictEqual(value.consumerInputs, original.consumerInputs)) throw new Error("Hermes archive or compiler consumer inputs changed; a new matching native generation is required");
  try { verifyCurrentHermesConsumer(repository, original); }
  catch (error) { throw new Error("Hermes current compiler consumer inputs differ; a new matching native generation is required", { cause: error }); }
}
