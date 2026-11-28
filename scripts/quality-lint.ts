import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Span = { offset: number; length: number; line: number; column: number };
type Diagnostic = { code?: string; message: string; severity?: string; filename: string; labels?: { span?: Span }[] };
type Baseline = { reason: string; files: Record<string, string[]> };

const root = resolve(import.meta.dir, "..");
const baselinePath = resolve(root, ".oxlint-nested-ternary-baseline.json");
const nestedTernaryCode = "eslint(no-nested-ternary)";

function spanHash(fileCache: Map<string, Buffer>, filename: string, span: Span | undefined): string {
  if (!span || span.offset < 0 || span.length <= 0) return "missing-span";
  let bytes = fileCache.get(filename);
  if (!bytes) {
    bytes = readFileSync(resolve(root, filename));
    fileCache.set(filename, bytes);
  }
  return createHash("sha256").update(bytes.subarray(span.offset, span.offset + span.length)).digest("hex").slice(0, 16);
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

function loadBaseline(): Baseline {
  const raw = JSON.parse(readFileSync(baselinePath, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || !("files" in raw) || typeof raw.files !== "object" || !raw.files) {
    throw new Error(`Invalid nested-ternary baseline: ${baselinePath}`);
  }
  return raw as Baseline;
}

function countMap(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function writeBaseline(diagnostics: readonly Diagnostic[]): void {
  const fileCache = new Map<string, Buffer>();
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
  const baseline: Baseline = {
    reason: "Pre-existing nested ternaries grandfathered when enabling no-nested-ternary (tracked for removal under B9). Each hash identifies one exact diagnostic span; adding any new nested ternary fails CI even inside listed files.",
    files,
  };
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Wrote ${diagnostics.length} nested-ternary span hashes across ${Object.keys(files).length} files`);
}

function checkDiagnostics(diagnostics: readonly Diagnostic[]): void {
  const baseline = loadBaseline();
  const fileCache = new Map<string, Buffer>();
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

const args = process.argv.slice(2);
const diagnostics = runOxlint();
if (args.length === 1 && args[0] === "--write-baseline") {
  writeBaseline(diagnostics);
} else if (args.length === 0) {
  checkDiagnostics(diagnostics);
} else {
  throw new Error("Usage: quality-lint [--write-baseline]");
}
