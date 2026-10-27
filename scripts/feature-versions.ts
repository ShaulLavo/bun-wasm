import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export function versionRecords(path: string, source: string): string[] {
  if (path.endsWith("package.json")) {
    const manifest: unknown = JSON.parse(source);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Invalid package manifest: ${path}`);
    if (!("version" in manifest)) return [];
    if (typeof manifest.version !== "string") throw new Error(`Invalid package version: ${path}`);
    return [manifest.version];
  }
  if (path.endsWith("Cargo.toml")) return Array.from(source.matchAll(/^version(?:\.workspace)?\s*=\s*[^\n]+/gm), match => match[0]);
  if (path.endsWith("Cargo.lock")) return source.split("[[package]]").filter(block => /^\nname = "bunwasm-[^"]+"\n/.test(block))
    .map(block => block.match(/^name = [^\n]+\nversion = [^\n]+/m)?.[0] ?? "").sort();
  if (path.endsWith("bun.lock")) return Array.from(source.split('  "packages": {')[0]!.matchAll(/^[ \t]+"(?:name|version)": [^\n]+/gm), match => match[0]);
  return [];
}

// A crate added to or removed from the workspace is not a version bump: compare the crates both
// locks share.
function comparable(path: string, records: readonly string[], other: readonly string[]): readonly string[] {
  if (!path.endsWith("Cargo.lock")) return records;
  const crate = (record: string) => record.split("\n")[0];
  const names = new Set(other.map(crate));
  return records.filter(record => names.has(crate(record)));
}

function files(ref: string, cwd: string): string[] {
  return execFileSync("git", ["ls-tree", "-r", "--name-only", ref], { cwd, encoding: "utf8" }).trim().split("\n")
    .filter(path => !/^(?:third_party|vendor|tests)\//.test(path) && /(?:^|\/)(?:package\.json|Cargo\.(?:toml|lock)|bun\.lock)$/.test(path));
}

export function verifyFeatureVersions(base: string, head: string, cwd = root): string[] {
  if (![base, head].every(ref => /^[0-9a-f]{40}$/.test(ref))) throw new Error("Expected full base and head commit IDs");
  const previous = new Set(files(base, cwd));
  const paths = files(head, cwd).filter(path => previous.has(path));
  for (const path of paths) {
    const [before, after] = [base, head].map(ref => versionRecords(path, execFileSync("git", ["show", `${ref}:${path}`], { cwd, encoding: "utf8" })));
    if (JSON.stringify(comparable(path, before!, after!)) !== JSON.stringify(comparable(path, after!, before!))) throw new Error(`Feature PR changes version records in ${path}. Keep main's versions; a release or required consumer pin owns its patch bump.`);
  }
  return paths;
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error("Usage: feature-versions.ts <base-sha> <head-sha>");
  console.log(`Unchanged feature version records in ${verifyFeatureVersions(base, head).length} manifests and local locks`);
}
