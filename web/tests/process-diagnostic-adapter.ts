import { writeResult, type SuiteAdapter } from "waffle/testing/page-runner";
import { processCommandId } from "./process-page-adapter";
import type { ProcessDiagnostic } from "./process-page-suite";

type DiagnosticEnvelope = { kind: "bun-process-diagnostic"; processResult: unknown; diagnostic: ProcessDiagnostic };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readProcessDiagnosticEnvelope(value: unknown): DiagnosticEnvelope {
  if (!record(value) || value.kind !== "bun-process-diagnostic" || !Object.hasOwn(value, "processResult"))
    throw new Error("process diagnostic envelope missing original result");
  const diagnostic = value.diagnostic;
  if (!record(diagnostic)) throw new Error("process diagnostic missing");
  if (diagnostic.status === "captured" && Object.hasOwn(diagnostic, "value"))
    return { kind: "bun-process-diagnostic", processResult: value.processResult, diagnostic: { status: "captured", value: diagnostic.value } };
  if (diagnostic.status === "error" && typeof diagnostic.error === "string")
    return { kind: "bun-process-diagnostic", processResult: value.processResult, diagnostic: { status: "error", error: diagnostic.error } };
  throw new Error("invalid process diagnostic");
}

export function processDiagnosticAdapter<R>(adapter: SuiteAdapter<R>): SuiteAdapter<R> {
  return {
    ...adapter,
    policy: {
      ...adapter.policy,
      check: (id, value) => adapter.policy.check(id, readProcessDiagnosticEnvelope(value).processResult),
    },
  };
}

type DiagnosticWrite = { status: "written"; path: string } | { status: "error"; error: string };

export async function writeProcessDiagnostics(resultPath: string, diagnosticPath: string, sink = writeResult): Promise<DiagnosticWrite> {
  try {
    const result: unknown = await Bun.file(resultPath).json();
    if (!record(result) || !record(result.results)) throw new Error("process suite result missing");
    const envelope = readProcessDiagnosticEnvelope(result.results[processCommandId]);
    await sink(diagnosticPath, envelope.diagnostic);
    return { status: "written", path: diagnosticPath };
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}
