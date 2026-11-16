import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { checkPlaygroundStdin, stdinCaseRecords, stdinCaseNames, type StdinCaseRecord } from "./playground-stdin";

export function stdinBrowser(names: readonly string[]): "chromium" | "webkit" {
  assert.equal(names.length, 1, "Select exactly one stdin browser");
  const name = names[0];
  assert.ok(name === "chromium" || name === "webkit", "unsupported stdin browser");
  return name;
}
export function assertStdinReport(value: unknown, browser: string): void {
  assert.ok(value && typeof value === "object" && "browser" in value && value.browser === browser);
  assert.ok("cases" in value && Array.isArray(value.cases));
  assert.deepEqual(value.cases.map(row => row.name), stdinCaseNames, "all six same-terminal command forms");
  assert.ok(value.cases.every(row => row.status === "passed" && row.cleanup?.safe === true), "all stdin cases passed safely");
  assert.ok("cleanup" in value && value.cleanup && typeof value.cleanup === "object" && "safe" in value.cleanup && value.cleanup.safe === true, "stdin driver cleanup");
}
async function main(): Promise<void> {
  const name = stdinBrowser(process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]);
  const { playwright, ready, session } = await import("./playground.mjs");
  const report: { browser: string; cases: readonly StdinCaseRecord[]; cleanup: { safe: boolean; error?: string } } = { browser: name, cases: stdinCaseRecords(), cleanup: { safe: false } };
  const persist = () => { if (process.env.BUN_WASM_STDIN_OUTPUT) writeFileSync(process.env.BUN_WASM_STDIN_OUTPUT, JSON.stringify(report, null, 2) + "\n"); };
  persist();
  const task = session("bun-wasm-stdin-");
  const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(1)); }, 840_000);
  const failures: unknown[] = [];
  try {
    const url = await task.serve();
    const browser = await task.launch(playwright[name]);
    const context = await browser.newContext(name === "webkit" ? playwright.devices["iPhone 15"] : {});
    const page = await context.newPage();
    await page.goto(`${url}?prompt=off&engine=browser`);
    assert.match(await ready(page), /ready/);
    await checkPlaygroundStdin(page, rows => { report.cases = rows; persist(); });
    console.log("PASS terminal stdin survives env and shebangs, accepts input, and ends only on EOF; pipes retain EOF");
  } catch (error) { failures.push(error); }
  finally {
    clearTimeout(timer);
    for (const row of report.cases) if (row.status === "planned") row.status = "not-run";
    try { await task.cleanup(); report.cleanup = { safe: true }; }
    catch (error) { report.cleanup = { safe: false, error: String(error) }; failures.push(error); }
    finally { persist(); }
  }
  if (failures.length) throw new AggregateError(failures, "Terminal stdin failed");
}
if (import.meta.main) await main();
