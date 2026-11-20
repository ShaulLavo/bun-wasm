import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withBrowserGuestRegression, type BrowserGuestContext } from "./browser-guest-wrapper";
import { rowIdentity } from "./browser-guest-catalogue";
import { assertStdinReport } from "../web/tests/browser-playground-stdin";

async function execute({ leg, regression, repository, directory, env, signal }: BrowserGuestContext): Promise<void> {
  const output = join(directory, "terminal-stdin.json");
  await regression.runChild({ signal, command: [process.execPath, join(repository, "web/tests/browser-playground-stdin.ts"), leg],
    cwd: join(repository, "web"), env: { ...env, BUN_WASM_STDIN_OUTPUT: output }, rows: regression.expected,
    evidence() {
      const report = JSON.parse(readFileSync(output, "utf8"));
      let error: string | undefined;
      try { assertStdinReport(report, leg); }
      catch (failure) { error = String(failure); }
      return regression.expected.map(row => ({ id: rowIdentity(row), status: error ? "failed" : "passed", detail: error ?? "All six same-terminal commands passed with foreground idle cleanup" }));
    } });
}

test("selected browser terminal stdin commands", async () => {
  await withBrowserGuestRegression({ owner: "terminal-stdin", controls: () => [],
    execute,
  });
}, 3_120_000);
