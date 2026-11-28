import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript-api";
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

type ParsedProjectConfig = {
  readonly extendsValue: string | undefined;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly files: readonly string[] | undefined;
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

function optionalStringListField(config: Record<string, unknown>, key: string, label: string): readonly string[] | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
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

function parseProjectConfig(source: string, label: string): ParsedProjectConfig {
  const raw = JSON.parse(source) as unknown;
  if (!isObject(raw)) throw new Error(`${label} must hold an object`);
  const extendsRaw = raw.extends;
  if (extendsRaw !== undefined && typeof extendsRaw !== "string") {
    throw new Error(`${label} "extends" must be a string`);
  }
  return {
    extendsValue: extendsRaw,
    include: stringListField(raw, "include", label),
    exclude: stringListField(raw, "exclude", label),
    files: optionalStringListField(raw, "files", label),
  };
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const pairs = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifyConfigRules(
  currentRules: Readonly<Record<string, unknown>>,
  baseRules: Readonly<Record<string, unknown>>,
  requiredRules: ReadonlySet<string>,
): void {
  for (const rule of requiredRules) {
    if (currentRules[rule] === false) {
      throw new Error(`structure config disables adopted rule: ${rule}`);
    }
  }
  for (const [rule, setting] of Object.entries(currentRules)) {
    if (setting === true) continue;
    if (Object.hasOwn(baseRules, rule) && canonicalJson(setting) === canonicalJson(baseRules[rule])) continue;
    throw new Error(`structure config weakens rule: ${rule}`);
  }
}

function readRepoComparisonJson(filePath: string): string | undefined {
  const rel = relative(root, resolve(filePath)).replaceAll("\\", "/");
  if (rel.startsWith("..") || rel.startsWith("/")) return undefined;
  return loadComparisonFile(rel, "STRUCTURE_BASE_REF");
}

function resolveEffectiveTsProject(projectPath: string, fromComparisonCommit: boolean): ts.ParsedCommandLine {
  const absPath = resolve(root, projectPath);
  const readJson = (path: string): string | undefined => {
    if (fromComparisonCommit && path.endsWith(".json")) {
      return readRepoComparisonJson(path);
    }
    return ts.sys.readFile(path);
  };
  const parsed = ts.readConfigFile(absPath, readJson);
  if (parsed.error) {
    throw new Error(`Failed to read ${projectPath}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`);
  }
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: path => (fromComparisonCommit && path.endsWith(".json") ? readRepoComparisonJson(path) !== undefined : ts.sys.fileExists(path)),
    readFile: readJson,
  };
  return ts.parseJsonConfigFileContent(parsed.config, host, dirname(absPath), undefined, absPath);
}

const resolutionOptions: readonly string[] = [
  "allowJs",
  "checkJs",
  "allowImportingTsExtensions",
  "allowArbitraryExtensions",
  "baseUrl",
  "paths",
  "pathsBasePath",
  "rootDir",
  "rootDirs",
  "module",
  "moduleDetection",
  "moduleResolution",
  "moduleSuffixes",
  "customConditions",
  "noResolve",
  "resolveJsonModule",
  "resolvePackageJsonExports",
  "resolvePackageJsonImports",
  "typeRoots",
  "types",
  "jsx",
  "target",
  "preserveSymlinks",
  "allowSyntheticDefaultImports",
  "esModuleInterop",
];

function verifyEffectiveProjectFiles(projectPath: string): void {
  const baseResolved = resolveEffectiveTsProject(projectPath, true);
  const currentResolved = resolveEffectiveTsProject(projectPath, false);
  const baseOptions = baseResolved.options as Record<string, unknown>;
  const currentOptions = currentResolved.options as Record<string, unknown>;
  for (const option of resolutionOptions) {
    if (canonicalJson(currentOptions[option]) !== canonicalJson(baseOptions[option])) {
      throw new Error(`structure project ${projectPath} changes resolution option: ${option}`);
    }
  }
  const currentFiles = new Set(currentResolved.fileNames.map(file => resolve(file)));
  for (const file of baseResolved.fileNames) {
    if (!currentFiles.has(resolve(file))) {
      throw new Error(`structure project ${projectPath} drops file from effective scope: ${relative(root, file)}`);
    }
  }
}

function verifyProjectFilesList(
  projectPath: string,
  currentFiles: readonly string[] | undefined,
  baseFiles: readonly string[] | undefined,
): void {
  if (baseFiles === undefined && currentFiles !== undefined) {
    throw new Error(`structure project ${projectPath} adds files restriction`);
  }
  if (baseFiles === undefined) return;
  const kept = new Set(currentFiles ?? []);
  for (const file of baseFiles) {
    if (!kept.has(file)) {
      throw new Error(`structure project ${projectPath} removes file: ${file}`);
    }
  }
}

function verifyProjectScope(projectPath: string): void {
  const baseSource = loadComparisonFile(projectPath, "STRUCTURE_BASE_REF");
  if (baseSource === undefined) return;
  const current = parseProjectConfig(readFileSync(resolve(root, projectPath), "utf8"), projectPath);
  const base = parseProjectConfig(baseSource, `comparison ${projectPath}`);
  if (current.extendsValue !== base.extendsValue) {
    throw new Error(`structure project ${projectPath} changes extends`);
  }
  const currentInclude = new Set(current.include);
  for (const glob of base.include) {
    if (!currentInclude.has(glob)) {
      throw new Error(`structure project ${projectPath} removes include: ${glob}`);
    }
  }
  const baseExclude = new Set(base.exclude);
  for (const glob of current.exclude) {
    if (!baseExclude.has(glob)) {
      throw new Error(`structure project ${projectPath} adds exclude: ${glob}`);
    }
  }
  verifyProjectFilesList(projectPath, current.files, base.files);
  verifyEffectiveProjectFiles(projectPath);
}

function verifyConfigMonotonic(requiredRules: ReadonlySet<string>): void {
  const current = parseConfig(readFileSync(configPath, "utf8"), configFilename);
  const baseSource = loadComparisonFile(configFilename, "STRUCTURE_BASE_REF");
  if (baseSource === undefined) {
    verifyConfigRules(current.rules, {}, requiredRules);
    return;
  }
  const base = parseConfig(baseSource, `comparison ${configFilename}`);
  verifyConfigRules(current.rules, base.rules, requiredRules);
  for (let index = 0; index < base.projects.length; index++) {
    const project = base.projects[index]!;
    if (current.projects[index] !== project) {
      throw new Error(`structure config reorders or removes project: ${project}`);
    }
    verifyProjectScope(project);
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
