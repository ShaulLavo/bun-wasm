import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const inventoryPath = "scripts/typescript-source-legacy.txt";
const runtimeInputPath = "scripts/typescript-source-runtime-inputs.txt";
const javascriptPath = /\.(?:cjs|js|mjs)$/;
const generatedDirectories = [
  "crates/bunwasm-build/generated/",
  "crates/bunwasm-runtime/generated/",
];
const generatedFiles = new Set([
  "crates/bunwasm-runtime/src/js/intl.js",
  "third_party/node-streams/entry.cjs",
  "third_party/streams/entry.js",
  "third_party/temporal/entry.js",
]);

export type SourceViolation = {
  kind: "inventory-growth" | "new-source" | "stale-inventory";
  path: string;
};

interface SourceAuditInput {
  paths: readonly string[];
  legacy: readonly string[];
  runtimeInputs?: readonly string[];
  baselineLegacy?: readonly string[];
}

function parseInventory(source: string, label: string): string[] {
  const paths = source.split("\n").filter(Boolean);
  const sorted = paths.toSorted();
  if (new Set(paths).size !== paths.length || paths.some((path, index) => path !== sorted[index])) {
    throw new Error(`${label} must be sorted and unique`);
  }
  if (paths.some(path => !javascriptPath.test(path))) throw new Error(`${label} entries must be JavaScript paths`);
  return paths;
}

export function parseLegacyInventory(source: string): string[] {
  return parseInventory(source, "Legacy JavaScript inventory");
}

export function parseRuntimeInputInventory(source: string): string[] {
  return parseInventory(source, "Runtime JavaScript input inventory");
}

function underAnyDirectory(path: string, directories: readonly string[]): boolean {
  return directories.some(directory => path.startsWith(directory));
}

function isEstablishedSource(path: string, legacy: ReadonlySet<string>, runtimeInputs: ReadonlySet<string>): boolean {
  if (generatedFiles.has(path) || runtimeInputs.has(path)) return true;
  if (underAnyDirectory(path, generatedDirectories)) return true;
  return legacy.has(path);
}

export function auditSourcePaths(input: SourceAuditInput): SourceViolation[] {
  const paths = new Set(input.paths);
  const legacy = new Set(input.legacy);
  const runtimeInputs = new Set(input.runtimeInputs);
  const baselineLegacy = input.baselineLegacy === undefined ? undefined : new Set(input.baselineLegacy);
  const violations: SourceViolation[] = [];
  for (const path of input.paths.filter(path => javascriptPath.test(path) && !isEstablishedSource(path, legacy, runtimeInputs))) {
    violations.push({ kind: "new-source", path });
  }
  for (const path of input.legacy.filter(path => !paths.has(path))) violations.push({ kind: "stale-inventory", path });
  for (const path of input.runtimeInputs?.filter(path => !paths.has(path)) ?? []) violations.push({ kind: "stale-inventory", path });
  if (baselineLegacy === undefined) return violations;
  for (const path of input.legacy.filter(path => !baselineLegacy.has(path))) violations.push({ kind: "inventory-growth", path });
  return violations;
}

function gitOutput(root: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) return undefined;
  return result.stdout;
}

function requiredGitOutput(root: string, args: readonly string[]): string {
  const output = gitOutput(root, args);
  if (output === undefined) throw new Error(`Git command failed: git ${args.join(" ")}`);
  return output;
}

function comparisonBase(root: string): string | undefined {
  if (process.env.GITHUB_EVENT_NAME === "pull_request") return requiredGitOutput(root, ["rev-parse", "HEAD^1"]).trim();
  if (process.env.CI === "true") return gitOutput(root, ["rev-parse", "HEAD^1"])?.trim();
  const upstream = gitOutput(root, ["rev-parse", "--verify", "origin/main"]);
  if (upstream === undefined) return undefined;
  return requiredGitOutput(root, ["merge-base", "HEAD", upstream.trim()]).trim();
}

function baselineInventory(root: string): string[] | undefined {
  const base = comparisonBase(root);
  if (base === undefined) return undefined;
  const source = gitOutput(root, ["show", `${base}:${inventoryPath}`]);
  return source === undefined ? undefined : parseLegacyInventory(source);
}

export function auditRepository(root: string): SourceViolation[] {
  const output = requiredGitOutput(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = output.split("\0").filter(path => path && existsSync(join(root, path)));
  const legacy = parseLegacyInventory(readFileSync(join(root, inventoryPath), "utf8"));
  const runtimeInputs = parseRuntimeInputInventory(readFileSync(join(root, runtimeInputPath), "utf8"));
  return auditSourcePaths({ paths, legacy, runtimeInputs, baselineLegacy: baselineInventory(root) });
}

function violationMessage(violation: SourceViolation): string {
  if (violation.kind === "new-source") return "new handwritten JavaScript; use TypeScript or classify a deliberate runtime input";
  if (violation.kind === "stale-inventory") return "stale legacy inventory entry; remove it with the deleted or renamed source";
  return "legacy inventory growth; new handwritten JavaScript is not allowed";
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const violations = auditRepository(root);
  for (const violation of violations) console.error(`${violation.path}: ${violationMessage(violation)}`);
  if (violations.length > 0) process.exitCode = 1;
}
