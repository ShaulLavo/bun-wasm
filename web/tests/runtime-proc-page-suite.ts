import { cleanupStorage, type PageSuite } from "waffle/testing/page-runner/page";
import { runtimeProcIds, type RuntimeProcRequest } from "./runtime-proc-page-contract";

export function createRuntimeProcPageSuite(runCase: (databaseName: string) => Promise<unknown>, errors: readonly string[] = []) {
  return {
    list: async () => ({ ids: runtimeProcIds }),
    async run(request, allocate) {
      await allocate({ kind: "indexeddb", name: request.databaseName });
      const result = await runCase(request.databaseName);
      return { result, errors: errors.slice() };
    },
    finish: cleanupStorage,
  } satisfies PageSuite<RuntimeProcRequest>;
}

export function observeRuntimeProcErrors(): string[] {
  const errors: string[] = [];
  window.addEventListener("error", event => errors.push(event.error instanceof Error ? event.error.message : event.message));
  window.addEventListener("unhandledrejection", event => errors.push(event.reason instanceof Error ? event.reason.message : String(event.reason)));
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const message = args.map(value => String(value)).join(" ");
    // Keep late console errors visible to the shared reporter until document retirement.
    window.dispatchEvent(new ErrorEvent("error", { message }));
    Reflect.apply(original, console, args);
  };
  return errors;
}
