import { cleanupStorage, type PageSuite } from "waffle/testing/page-runner/page";
import { processDiagnosticError } from "./process-diagnostic-error";
import { processCommandId, processResultForTransport, type ProcessObservation, type ProcessRequest } from "./process-page-adapter";

export type ProcessPageDiagnostic = () => unknown;
export type ProcessDiagnostic = { status: "captured"; value: unknown } | { status: "error"; error: string };

declare global {
  interface Window { __bunProcessPageDiagnostic?: ProcessPageDiagnostic }
}

function captureDiagnostic(collect: ProcessPageDiagnostic): ProcessDiagnostic {
  try {
    const encoded = JSON.stringify(collect());
    if (encoded === undefined) throw new Error("diagnostic must be JSON serializable");
    if (new TextEncoder().encode(encoded).byteLength > 16_384) throw new Error("diagnostic exceeds 16 KiB UTF-8 limit");
    return { status: "captured", value: JSON.parse(encoded) };
  } catch (error) {
    return { status: "error", error: processDiagnosticError(error) };
  }
}

function resultFits(value: object): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 49_152;
}

function diagnosticResult(original: unknown, collect: ProcessPageDiagnostic): unknown {
  const encoded = JSON.stringify(original);
  if (encoded === undefined) return original;
  const processResult: unknown = JSON.parse(encoded);
  const envelope = { kind: "bun-process-diagnostic", processResult, diagnostic: captureDiagnostic(collect) };
  if (resultFits(envelope)) return envelope;
  envelope.diagnostic = { status: "error", error: "diagnostic omitted to preserve the 48 KiB primary result limit" };
  return resultFits(envelope) ? envelope : processResult;
}

type CommandResult = Pick<ProcessObservation, "result" | "progress">;

export function observeProcessPageErrors(): string[] {
  const errors: string[] = [];
  window.addEventListener("error", event => {
    errors.push(event.error instanceof Error ? event.error.message : String(event.error ?? event.message));
  });
  window.addEventListener("unhandledrejection", event => {
    errors.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
  });
  return errors;
}

export function createProcessPageSuite(runCases: (databaseName: string) => Promise<CommandResult>, errors: readonly string[], diagnostic?: ProcessPageDiagnostic) {
  return {
    list: async () => ({ ids: [processCommandId] }),
    async run(request, allocate) {
      await allocate({ kind: "indexeddb", name: request.databaseName });
      const result = await runCases(request.databaseName);
      const processResult = processResultForTransport({ ...result, pageErrors: errors });
      if (!diagnostic || processResult === undefined) return processResult;
      return diagnosticResult(processResult, diagnostic);
    },
    finish: cleanupStorage,
  } satisfies PageSuite<ProcessRequest>;
}
