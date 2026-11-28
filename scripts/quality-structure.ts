import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadComparisonFile } from "./quality-lint";

const root = resolve(import.meta.dir, "..");
const allowFilename = ".unknot.allow";
const allowPath = resolve(root, allowFilename);
// Matches unknot's default adopted rule set when `# rules:` is omitted.
const defaultUnknotRules = ["module-cycle", "tangle", "field-leak", "shallow-module"];

type ParsedAllowlist = {
  readonly rules: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, number>;
};

function parseAllowlist(source: string): ParsedAllowlist {
  const lines = source.split(/\r?\n/).map(line => line.trim());
  const ruleHeader = lines.find(line => line.startsWith("# rules:"));
  const rules = new Set(
    ruleHeader ? ruleHeader.slice("# rules:".length).trim().split(/\s+/).filter(Boolean) : defaultUnknotRules,
  );
  const entries = new Map<string, number>();
  for (const line of lines) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const normalized = line.replace(/\s+/g, " ");
    entries.set(normalized, (entries.get(normalized) ?? 0) + 1);
  }
  return { rules, entries };
}

function verifyAllowlistMonotonic(): void {
  const current = parseAllowlist(readFileSync(allowPath, "utf8"));
  const baseSource = loadComparisonFile(allowFilename, "STRUCTURE_BASE_REF");
  if (baseSource === undefined) return;
  const base = parseAllowlist(baseSource);
  for (const rule of base.rules) {
    if (!current.rules.has(rule)) {
      throw new Error(`structure allowlist removes adopted rule: ${rule}`);
    }
  }
  for (const [entry, count] of current.entries.entries()) {
    const baseCount = base.entries.get(entry);
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
