import { exitProvenance } from "./exit-provenance.ts";

export interface ComparisonRow {
  readonly app: string;
  readonly host: string;
  readonly stage: string;
  readonly engine: "quickjs" | "jsc" | "browser" | "reference";
  readonly status: "pass" | "fail" | "blocked";
  readonly category?: "a" | "b" | "c" | "d" | "e" | "f";
  readonly passesOn?: readonly ComparisonRow["engine"][];
}

type ComparedRow<Row extends ComparisonRow> = Row | (Omit<Row, "category" | "passesOn"> & {
  category: "f";
  passesOn: ComparisonRow["engine"][];
});

export function stageOutput(log: string, command: string): string {
  // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const start = lines.findLastIndex(line => plainPromptCommand(line, command));
  if (start === -1) throw new Error(`Missing stage boundary for ${command}`);
  const end = lines.findIndex((line, index) => index > start && plainPrompt(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function plainPrompt(line: string): boolean {
  return /^(?:\[\d+\] )?\$(?: |$)/.test(line.trimStart());
}

function plainPromptCommand(line: string, command: string): boolean {
  const candidate = line.trimStart();
  return plainPrompt(candidate) && candidate.endsWith(`$ ${command}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lintMessageDiagnostic(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.severity !== 1 && value.severity !== 2) return undefined;
  if (typeof value.message !== "string" || !value.message) return undefined;
  return value.message;
}

function lintResultDiagnostics(value: unknown): string[] {
  if (!isRecord(value) || typeof value.filePath !== "string" || !Array.isArray(value.messages)) return [];
  return value.messages.map(lintMessageDiagnostic).filter((message): message is string => message !== undefined);
}

function jsonLintDiagnostic(line: string): string | undefined {
  if (!line.startsWith("[") || !line.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.flatMap(lintResultDiagnostics)[0];
  } catch {
    return undefined;
  }
}

function firstJsonLintDiagnostic(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const diagnostic = jsonLintDiagnostic(line);
    if (diagnostic) return diagnostic;
  }
  return undefined;
}

export function firstError(output: string): string {
  // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map(line => line.trim().replace(/^Linting and checking validity of types\s*\.*(?=(?:\w*Error|E[A-Z][A-Z0-9_]+):)/, "").replace(/^\d{1,2}:\d{2}:\d{2} [AP]M \[vite\] (?:\([^)]*\) )?/, "").replace(/^(?:unhandled\s*Rejection|uncaught\s*Exception)(?:\s*:\s*|\s+)\[?(\w*Error:.*?)\]?$/i, "$1").replace(/^\[((?:\w*Error|error):.*)\]$/, "$1"));
  const diagnostic = lines.find(line => /^(?:(?:\w*Error|error|panic|fatal|bun-wasm|E[A-Z][A-Z0-9_]+):|Unexpected early exit\.|Error when evaluating SSR module |circular import:|Export named .* not found in module |The requested module .*does not provide an export named|memory allocation of \d+ bytes failed|thread '.+' panicked|[^|\n]+error TS\d+:)/i.test(line)) ?? firstJsonLintDiagnostic(lines);
  const exit = exitProvenance({ code: null, output }).runtimeExits.at(-1);
  return (diagnostic ?? (exit ? `Runtime exited ${exit.code}: ${exit.reason}` : "No diagnostic before exit or deadline")).slice(0, 500);
}

export function failure(output: string, stage: string): { category: "a" | "b" | "c" | "d"; blocker: string } {
  const blocker = firstError(output);
  if (/current platform .*wasm32|Native Prisma engine|native addon|\.node\b|dlopen|unsupported.*(platform|architecture)/i.test(blocker)) return { category: "a", blocker };
  if (/node:child_process|external executable|IPC.*not|spawn.*(not supported|not implemented)/i.test(blocker)) return { category: "b", blocker };
  if (/tryEnableSourceMapsForHost|legacy-cli\.mjs|No such module: fs/i.test(blocker)) return { category: "c", blocker };
  return { category: "d", blocker: `${stage}: ${blocker}` };
}

export function compareEngines<Row extends ComparisonRow>(rows: readonly Row[]): ComparedRow<Row>[] {
  return rows.map(row => {
    if (row.engine !== "quickjs" || row.status !== "fail") return row;
    const passesOn = rows.filter(other => other.app === row.app && other.host === row.host && other.stage === row.stage && ["jsc", "browser"].includes(other.engine) && other.status === "pass").map(other => other.engine);
    return passesOn.length ? { ...row, category: "f", passesOn } : row;
  });
}
