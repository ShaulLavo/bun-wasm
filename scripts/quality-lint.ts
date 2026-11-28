import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import ts from "typescript-api";
import { resolveBaseRef } from "./quality-duplicates";

type Span = { offset: number; length: number; line: number; column: number };
type Diagnostic = { code?: string; message: string; severity?: string; filename: string; labels?: { span?: Span }[] };
type CachedFile = {
  readonly bytes: Buffer;
  readonly lines: readonly string[];
  readonly sourceFile: ts.SourceFile;
};
type NestedTernaryBaseline = {
  readonly reason: string;
  readonly files: Readonly<Record<string, readonly string[]>>;
};

const root = resolve(import.meta.dir, "..");
const baselineFilename = ".oxlint-nested-ternary-baseline.json";
const baselinePath = resolve(root, baselineFilename);
const nestedTernaryCode = "eslint(no-nested-ternary)";
const fingerprintPattern = /^[0-9a-f]{16}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scriptKindFor(filename: string): ts.ScriptKind {
  switch (extname(filename).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".ts": case ".mts": case ".cts": return ts.ScriptKind.TS;
    default: return ts.ScriptKind.JS;
  }
}

function loadCachedFile(fileCache: Map<string, CachedFile>, filename: string): CachedFile {
  const cached = fileCache.get(filename);
  if (cached) return cached;
  const bytes = readFileSync(resolve(root, filename));
  const text = bytes.toString("utf8");
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, scriptKindFor(filename));
  const entry: CachedFile = { bytes, lines: text.split(/\r?\n/), sourceFile };
  fileCache.set(filename, entry);
  return entry;
}

function nearestNonEmptyLine(lines: readonly string[], startIndex: number, step: -1 | 1): string {
  for (let offset = 1; offset <= 5; offset++) {
    const index = startIndex + offset * step;
    if (index < 0 || index >= lines.length) return "";
    const trimmed = lines[index]!.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

function propertyNameLabel(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return "<computed>";
}

function declarationLabel(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return `function:${node.name?.text ?? "<anon>"}`;
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return `class:${node.name?.text ?? "<anon>"}`;
  if (ts.isMethodDeclaration(node)) return `method:${propertyNameLabel(node.name)}`;
  if (ts.isGetAccessorDeclaration(node)) return `get:${propertyNameLabel(node.name)}`;
  if (ts.isSetAccessorDeclaration(node)) return `set:${propertyNameLabel(node.name)}`;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return `var:${node.name.text}`;
  if (ts.isPropertyAssignment(node)) return `prop:${propertyNameLabel(node.name)}`;
  if (ts.isFunctionExpression(node) && node.name) return `fn:${node.name.text}`;
  return undefined;
}

function enclosingDeclarationPath(sourceFile: ts.SourceFile, offset: number): string {
  const labels: string[] = [];
  let current: ts.Node = sourceFile;
  while (true) {
    let next: ts.Node | undefined;
    ts.forEachChild(current, child => {
      if (next !== undefined) return;
      if (child.getStart(sourceFile) <= offset && offset < child.getEnd()) next = child;
    });
    if (!next) break;
    const label = declarationLabel(next);
    if (label) labels.push(label);
    current = next;
  }
  return labels.length > 0 ? labels.join(">") : "<top-level>";
}

function spanHash(fileCache: Map<string, CachedFile>, filename: string, span: Span | undefined): string {
  if (!span || span.offset < 0 || span.length <= 0) return "missing-span";
  const { bytes, lines, sourceFile } = loadCachedFile(fileCache, filename);
  const lineIndex = Math.max(0, span.line - 1);
  const enclosing = enclosingDeclarationPath(sourceFile, span.offset);
  const prevLine = nearestNonEmptyLine(lines, lineIndex, -1);
  const currentLine = lines[lineIndex]?.trim() ?? "";
  const nextLine = nearestNonEmptyLine(lines, lineIndex, 1);
  return createHash("sha256")
    .update(`${filename}\0${enclosing}\0${prevLine}\0${currentLine}\0${nextLine}\0`)
    .update(bytes.subarray(span.offset, span.offset + span.length))
    .digest("hex")
    .slice(0, 16);
}

function formatDiagnostic(diagnostic: Diagnostic): string {
  const span = diagnostic.labels?.[0]?.span;
  const location = span ? `${diagnostic.filename}:${span.line}:${span.column}` : diagnostic.filename;
  return `${location} ${diagnostic.code ?? "oxlint"}: ${diagnostic.message}`;
}

function runOxlint(): Diagnostic[] {
  const oxlint = resolve(root, "node_modules/.bin/oxlint");
  const result = spawnSync(oxlint, ["--deny-warnings", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) {
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
    return [];
  }
  const parsed = JSON.parse(result.stdout) as { diagnostics?: Diagnostic[] };
  if (!Array.isArray(parsed.diagnostics)) throw new Error("Unexpected oxlint JSON output");
  return parsed.diagnostics;
}

function parseBaseline(value: unknown, label = "nested-ternary baseline"): NestedTernaryBaseline {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason !== value.reason.trim()) {
    throw new Error(`${label}.reason must be a trimmed, nonempty string`);
  }
  if (/[\r\n\u2028\u2029]/.test(value.reason)) throw new Error(`${label}.reason must be single-line`);
  if (!isObject(value.files)) throw new Error(`${label}.files must be an object`);
  const files: Record<string, string[]> = {};
  for (const [filename, hashes] of Object.entries(value.files)) {
    if (!Array.isArray(hashes) || hashes.length === 0) {
      throw new Error(`${label}.files[${filename}] must be a nonempty array`);
    }
    for (const hash of hashes) {
      if (typeof hash !== "string" || !fingerprintPattern.test(hash)) {
        throw new Error(`${label}.files[${filename}] has malformed fingerprint: ${String(hash)}`);
      }
    }
    files[filename] = hashes.slice();
  }
  return { reason: value.reason, files };
}

function loadBaseline(): NestedTernaryBaseline {
  return parseBaseline(JSON.parse(readFileSync(baselinePath, "utf8")));
}

function countMap(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function compareAllowances(
  current: Readonly<Record<string, readonly string[]>>,
  base: Readonly<Record<string, readonly string[]>>,
): void {
  for (const [filename, hashes] of Object.entries(current)) {
    const baseHashes = base[filename];
    if (!baseHashes) {
      throw new Error(`nested-ternary baseline adds allowance for file ${filename}`);
    }
    const baseCounts = countMap(baseHashes);
    for (const [hash, count] of countMap(hashes).entries()) {
      const baseCount = baseCounts.get(hash);
      if (baseCount === undefined) {
        throw new Error(`nested-ternary baseline adds allowance ${filename}:${hash}`);
      }
      if (count > baseCount) {
        throw new Error(`nested-ternary baseline increases allowance ${filename}:${hash}: ${baseCount} -> ${count}`);
      }
    }
  }
}

function readCommittedBaselineFile(ref: string, relativePath: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${relativePath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

export function loadComparisonFile(relativePath: string, explicitEnvKey: string): string | undefined {
  const explicitRef = process.env[explicitEnvKey];
  const env = explicitRef === undefined ? process.env : { ...process.env, JSCPD_BASE_REF: explicitRef };
  const baseRef = resolveBaseRef(root, env);
  const baseSource = readCommittedBaselineFile(baseRef, relativePath);
  if (baseSource !== undefined) return baseSource;
  if (explicitRef !== undefined) {
    throw new Error(`Unable to read ${relativePath} from comparison commit ${baseRef}`);
  }
  return readCommittedBaselineFile("HEAD", relativePath);
}

function verifyBaselineMonotonic(current: NestedTernaryBaseline): void {
  const baseSource = loadComparisonFile(baselineFilename, "LINT_BASE_REF");
  if (baseSource === undefined) return;
  const base = parseBaseline(JSON.parse(baseSource), "comparison nested-ternary baseline");
  compareAllowances(current.files, base.files);
}

function writeBaseline(diagnostics: readonly Diagnostic[]): void {
  const fileCache = new Map<string, CachedFile>();
  const grouped = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== nestedTernaryCode) {
      console.error(formatDiagnostic(diagnostic));
      process.exit(1);
    }
    const hash = spanHash(fileCache, diagnostic.filename, diagnostic.labels?.[0]?.span);
    const list = grouped.get(diagnostic.filename) ?? [];
    list.push(hash);
    grouped.set(diagnostic.filename, list);
  }
  const files: Record<string, string[]> = {};
  for (const name of Array.from(grouped.keys()).sort()) {
    files[name] = grouped.get(name)!.toSorted();
  }
  const baseline: NestedTernaryBaseline = {
    reason: "Pre-existing nested ternaries grandfathered when enabling no-nested-ternary (tracked for removal under B9). Each hash binds one diagnostic span to its AST enclosing declaration path and neighboring lines, and CI rejects any baseline growth against the comparison commit.",
    files,
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Wrote ${diagnostics.length} nested-ternary AST hashes across ${Object.keys(files).length} files`);
}

function checkDiagnostics(diagnostics: readonly Diagnostic[]): void {
  const baseline = loadBaseline();
  verifyBaselineMonotonic(baseline);
  const fileCache = new Map<string, CachedFile>();
  const failures: string[] = [];
  const remaining = new Map<string, Map<string, number>>();
  for (const [file, hashes] of Object.entries(baseline.files)) {
    remaining.set(file, countMap(hashes));
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== nestedTernaryCode) {
      failures.push(formatDiagnostic(diagnostic));
      continue;
    }
    const hash = spanHash(fileCache, diagnostic.filename, diagnostic.labels?.[0]?.span);
    const allowed = remaining.get(diagnostic.filename);
    const left = allowed?.get(hash) ?? 0;
    if (left > 0) {
      allowed!.set(hash, left - 1);
      continue;
    }
    failures.push(`${formatDiagnostic(diagnostic)} [new nested ternary, span ${hash}]`);
  }
  if (failures.length === 0) return;
  for (const line of failures) console.error(line);
  process.exit(1);
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const diagnostics = runOxlint();
    if (args.length === 1 && args[0] === "--write-baseline") {
      writeBaseline(diagnostics);
    } else if (args.length === 0) {
      checkDiagnostics(diagnostics);
    } else {
      throw new Error("Usage: quality-lint [--write-baseline]");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
