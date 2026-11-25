import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { buildSite, verifySite } from "./browser-guest-site";
import { session } from "../web/tests/playground.mjs";
import { typescriptLanguageServerScenario, type LanguageServerRun } from "../web/tests/browser-typescript-language-server.ts";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

function expectTypeScriptAnswers(run: LanguageServerRun) {
  expect(run.typescript).toEqual({ version: "6.0.3", source: "workspace" });
  expect(run.answers.diagnostic).toBe("Type 'string' is not assignable to type 'number'.");
  expect(run.answers.hover).toContain("describePoint(point: Point): string");
  expect(run.answers.completion).toEqual(["x", "y"]);
  expect(run.answers.definition).toBe("file:///home/user/lsp-typescript/src/geometry.ts");
  expect(run.answers.packageDefinition).toMatch(/^file:\/\/\/home\/user\/lsp-typescript\/node_modules\/tiny-invariant\/.*\.d\.ts$/);
}

test("chromium: typescript-language-server answers over stdio in the guest, before and after a reload", async () => {
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !provided) throw new Error("CI must provide the existing browser-guest site");
  const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-lsp-site-"));
  const directory = provided ? resolve(provided) : scratch!;
  const previousRoot = process.env.ROOT;
  const task = session("bun-wasm-lsp-browser-");
  const marker = `--bun-wasm-lsp-probe=${process.pid}`;
  try {
    const before = provided ? verifySite(directory) : buildSite(directory);
    process.env.ROOT = join(directory, "site");
    const url = await task.serve();
    const browser = await chromium.launch({ args: [marker] });
    try {
      const report = await typescriptLanguageServerScenario(browser, url, marker);
      console.log(`typescript-language-server report ${JSON.stringify(report)}`);
      expectTypeScriptAnswers(report.cold);
      expectTypeScriptAnswers(report.afterReload);
    } finally {
      await browser.close();
    }
    expect(verifySite(directory)).toEqual(before);
  } finally {
    if (previousRoot === undefined) delete process.env.ROOT;
    else process.env.ROOT = previousRoot;
    await task.cleanup();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}, 1_200_000);
