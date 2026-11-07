import { cleanupStorage, type PageSuite } from "waffle/testing/page-runner/page";
import { processCommandId, processResultForTransport, type ProcessObservation, type ProcessRequest } from "./process-page-adapter";

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

export function createProcessPageSuite(runCases: (databaseName: string) => Promise<CommandResult>, errors: readonly string[]) {
  return {
    list: async () => ({ ids: [processCommandId] }),
    async run(request, allocate) {
      await allocate({ kind: "indexeddb", name: request.databaseName });
      const result = await runCases(request.databaseName);
      return processResultForTransport({ ...result, pageErrors: errors });
    },
    finish: cleanupStorage,
  } satisfies PageSuite<ProcessRequest>;
}
