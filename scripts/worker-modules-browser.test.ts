import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withBrowserGuestRegression, type BrowserGuestContext } from "./browser-guest-wrapper";
import { rowIdentity } from "./browser-guest-catalogue";
import { assertWorkerModuleReport, workerModuleReport } from "../web/tests/browser-worker-modules";

function controls(browser: string): string[] {
  return workerModuleReport(browser).iterations.map(row => `${browser}:${row.variant}:${row.iteration}`).concat([`${browser}:module-http`, `${browser}:eval-http`]);
}
async function execute({ leg, regression, repository, directory, env, signal }: BrowserGuestContext): Promise<void> {
  const output = join(directory, "worker-modules.json");
  await regression.runChild({ signal, command: [process.execPath, join(repository, "web/tests/browser-worker-modules.ts"), leg],
    cwd: join(repository, "web"), env: { ...env, BUN_WASM_TEST_URL: undefined, BUN_WASM_WORKER_MODULES_OUTPUT: output }, rows: regression.expected,
    evidence() {
      const value = JSON.parse(readFileSync(output, "utf8"));
      if (!Array.isArray(value) || value.length !== 1) throw new Error("Worker driver must return exactly one browser");
      let error: string | undefined;
      try { assertWorkerModuleReport(value[0], leg); }
      catch (failure) { error = String(failure); }
      for (const id of controls(leg)) regression.recordControl({ id, status: error ? "failed" : "passed", detail: error ?? "Exact worker invocation and both HTTP observations passed" });
      return regression.expected.map(row => ({ id: rowIdentity(row), status: error ? "failed" : "passed", detail: error ?? "20 same-page controlled invocations and one independent uncontrolled invocation" }));
    } });
}

test("selected browser worker module repetitions", async () => {
  await withBrowserGuestRegression({ owner: "worker-modules", controls: ({ leg }) => controls(leg),
    execute,
  });
}, 3_120_000);
