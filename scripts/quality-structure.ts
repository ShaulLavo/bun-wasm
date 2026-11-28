import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadComparisonFile } from "./quality-lint";

const root = resolve(import.meta.dir, "..");
const allowFilename = ".unknot.allow";
const configFilename = ".unknot.json";
const allowPath = resolve(root, allowFilename);
const configPath = resolve(root, configFilename);
// Matches unknot's default adopted rule set when `# rules:` is omitted.
const defaultUnknotRules = ["module-cycle", "tangle", "field-leak", "shallow-module"];

type ParsedAllowlist = {
  readonly rules: ReadonlySet<string>;
  readonly entries: ReadonlyMap<string, number>;
};

type ParsedConfig = {
  readonly projects: readonly string[];
  readonly ignore: readonly string[];
  readonly rules: Readonly<Record<string, unknown>>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringListField(config: Record<string, unknown>, key: string, label: string): readonly string[] {
  const value = config[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    throw new Error(`${label} "${key}" must be a list of strings`);
  }
  return value;
}

function parseConfig(source: string, label: string): ParsedConfig {
  const raw = JSON.parse(source) as unknown;
  if (!isObject(raw)) throw new Error(`${label} must hold an object`);
  const projects = stringListField(raw, "projects", label);
  const ignore = stringListField(raw, "ignore", label);
  const rulesValue = raw.rules;
  if (rulesValue !== undefined && !isObject(rulesValue)) {
    throw new Error(`${label} "rules" must be an object`);
  }
  return { projects, ignore, rules: rulesValue ?? {} };
}

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

function verifyAllowlistRules(current: ReadonlySet<string>, base: ReadonlySet<string>): void {
  for (const rule of base) {
    if (!current.has(rule)) {
      throw new Error(`structure allowlist removes adopted rule: ${rule}`);
    }
  }
}

function verifyAllowlistEntries(current: ReadonlyMap<string, number>, base: ReadonlyMap<string, number>): void {
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

function verifyConfigMonotonic(requiredRules: ReadonlySet<string>): void {
  const current = parseConfig(readFileSync(configPath, "utf8"), configFilename);
  for (const rule of requiredRules) {
    if (current.rules[rule] === false) {
      throw new Error(`structure config disables adopted rule: ${rule}`);
    }
  }
  const baseSource = loadComparisonFile(configFilename, "STRUCTURE_BASE_REF");
  if (baseSource === undefined) return;
  const base = parseConfig(baseSource, `comparison ${configFilename}`);
  const currentProjects = new Set(current.projects);
  for (const project of base.projects) {
    if (!currentProjects.has(project)) {
      throw new Error(`structure config removes project: ${project}`);
    }
  }
  const baseIgnore = new Set(base.ignore);
  for (const pattern of current.ignore) {
    if (!baseIgnore.has(pattern)) {
      throw new Error(`structure config adds ignore pattern: ${pattern}`);
    }
  }
}

function verifyStructurePolicy(): void {
  const current = parseAllowlist(readFileSync(allowPath, "utf8"));
  const baseSource = loadComparisonFile(allowFilename, "STRUCTURE_BASE_REF");
  const requiredRules = new Set(current.rules);
  if (baseSource !== undefined) {
    const base = parseAllowlist(baseSource);
    verifyAllowlistRules(current.rules, base.rules);
    verifyAllowlistEntries(current.entries, base.entries);
    for (const rule of base.rules) requiredRules.add(rule);
  }
  verifyConfigMonotonic(requiredRules);
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
    verifyStructurePolicy();
    runUnknot("src");
    runUnknot(".");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
