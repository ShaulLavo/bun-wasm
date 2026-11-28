import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadComparisonFile } from "./quality-lint";

const root = resolve(import.meta.dir, "..");
const allowFilename = ".unknot.allow";
const allowPath = resolve(root, allowFilename);

function parseAllowlist(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const normalized = line.replace(/\s+/g, " ");
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function verifyAllowlistMonotonic(): void {
  const current = parseAllowlist(readFileSync(allowPath, "utf8"));
  const baseSource = loadComparisonFile(allowFilename, "STRUCTURE_BASE_REF");
  if (baseSource === undefined) return;
  const base = parseAllowlist(baseSource);
  for (const [entry, count] of current.entries()) {
    const baseCount = base.get(entry);
    if (baseCount === undefined) {
      throw new Error(`structure allowlist adds entry: ${entry}`);
    }
    if (count > baseCount) {
      throw new Error(`structure allowlist increases entry ${entry}: ${baseCount} -> ${count}`);
    }
  }
}

function runUnknot(target: string): void {
  const unknot = resolve(root, "node_modules/.bin/unknot");
  const result = spawnSync(unknot, [target], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(`unknot ${target} terminated by ${result.signal}`);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (import.meta.main) {
  try {
    verifyAllowlistMonotonic();
    runUnknot("src");
    runUnknot(".");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
