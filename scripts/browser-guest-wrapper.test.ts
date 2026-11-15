import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { coverageFixture } from "./browser-guest-coverage-fixture";
import { rowIdentity, type BrowserGuestSelection } from "./browser-guest-catalogue";
import { withBrowserGuestRegression, type BrowserGuestContext } from "./browser-guest-wrapper";
import { linuxProcess } from "./process-owner.mts";

const cleanup = new Set<string>();
afterEach(() => { for (const directory of cleanup) rmSync(directory, { recursive: true, force: true }); cleanup.clear(); });
const selection: BrowserGuestSelection = [{ owner: "installer-links", engines: ["browser"] }];
async function fixture() {
  const site = await coverageFixture(cleanup, selection);
  await site.prepare();
  const reports = mkdtempSync("/work/tmp/bun-wasm-boundary-"); cleanup.add(reports);
  return { site, reports, env: { PATH: process.env.PATH, BUN_WASM_BROWSER_COVERAGE_SELECTION: JSON.stringify(selection),
    TMPDIR: reports, BUN_WASM_TEST_BROWSERS: "chromium", BUN_WASM_BROWSER_SITE: site.out, BUN_WASM_BROWSER_COVERAGE_REPORTS: reports } };
}
async function smallChild(context: BrowserGuestContext, code = "console.log('completed')") {
  await context.regression.runChild({ command: [process.execPath, "-e", code], cwd: context.repository, env: context.env,
    rows: context.regression.expected, signal: context.signal, hangSeconds: 900,
    evidence: result => readFileSync(result.log, "utf8").includes("completed")
      ? context.regression.expected.map(row => ({ id: rowIdentity(row), status: "passed", detail: "owned child completed" })) : [] });
}

test("requires explicit scheduled owner and every boundary input, before launching", async () => {
  const { env } = await fixture();
  for (const name of Object.keys(env).filter(name => name !== "PATH" && name !== "TMPDIR")) {
    const missing: NodeJS.ProcessEnv = { ...env }; delete missing[name];
    await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: smallChild }, missing)).rejects.toThrow();
  }
  await expect(withBrowserGuestRegression({ owner: "subprocess", controls: () => [], execute: smallChild }, env)).rejects.toThrow("owner is missing");
});
test("rejects conflicting driver, root, browser and benchmark settings", async () => {
  const { env } = await fixture();
  for (const name of ["ROOT", "ENGINES", "SLOTS", "PLAYWRIGHT", "BUN_WASM_TEST_URL", "BUN_WASM_TEST_TMP", "ENGINE_INTERRUPTION_OUTPUT", "BENCH_CASE", "SAFARI_CASE", "ISOLATE"]) {
    await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: smallChild }, { ...env, [name]: "" })).rejects.toThrow("Conflicting");
  }
  for (const browser of ["", "firefox", "chromium,webkit", "chromium,chromium"]) {
    await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: smallChild }, { ...env, BUN_WASM_TEST_BROWSERS: browser })).rejects.toThrow("exactly one browser");
  }
});
test("verifies only the scheduled owner's subset and sets verified child root with private scratch", async () => {
  const { env, reports, site } = await fixture();
  const larger = selection.concat([{ owner: "subprocess", engines: ["jsc"] }]);
  let scratch = "";
  await withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: async context => {
    scratch = context.scratch;
    expect(context.artifact.selection).toEqual(selection);
    expect(context.env.ROOT).toBe(site.site);
    expect(context.env.TMPDIR).toBe(scratch);
    expect(scratch.startsWith(join(reports, "bun-wasm-bg-"))).toBe(true);
    expect(context.engines).toEqual(["browser"]);
    expect(existsSync(join(context.directory, "rows.json"))).toBe(true);
    await smallChild(context);
  } }, { ...env, BUN_WASM_BROWSER_COVERAGE_SELECTION: JSON.stringify(larger) });
  expect(existsSync(scratch)).toBe(false);
  expect(readdirSync(reports)).toHaveLength(1);
  expect(readFileSync(join(reports, readdirSync(reports)[0]!, "ownership.json"), "utf8")).toContain('"removed"');
});
test("finally finalizes missing rows and preserves primary failures while removing drained scratch", async () => {
  const { env, reports } = await fixture();
  let scratch = "";
  await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => ["required"], execute: async context => {
    scratch = context.scratch; throw new Error("original assertion");
  } }, env)).rejects.toThrow("Browser guest wrapper failed");
  const ledger = readFileSync(join(reports, readdirSync(reports)[0]!, "rows.json"), "utf8");
  expect(ledger).toContain('"not-run"');
  expect(ledger).toContain('"required"');
  expect(existsSync(scratch)).toBe(false);
});
test("zero exit without marker and failed children remain red after safe cleanup", async () => {
  const { env } = await fixture();
  for (const code of ["console.log('no marker')", "console.log('completed'); process.exitCode=1"]) {
    await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: context => smallChild(context, code) }, env)).rejects.toThrow("wrapper failed");
  }
});

test("cancellation reaches the real supervisor and finally removes scratch after drain", async () => {
  const { env, reports } = await fixture();
  let scratch = "";
  await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: async context => {
    scratch = context.scratch;
    const child = smallChild(context, "setInterval(()=>{},1000)");
    process.emit("SIGTERM");
    await child;
  } }, env)).rejects.toThrow();
  const name = readdirSync(reports)[0]; if (!name) throw new Error("Missing cancellation ledger");
  const ledger = JSON.parse(readFileSync(join(reports, name, "rows.json"), "utf8"));
  expect(ledger.children[0].cancelled).toBe(true);
  expect(ledger.children[0].cleanup.kind).toBe("drained");
  expect(existsSync(scratch)).toBe(false);
}, 30_000);

test("unsafe cleanup retains its scratch and ownership evidence, with no next engine", async () => {
  const { env, reports } = await fixture();
  let scratch = "";
  await expect(withBrowserGuestRegression({ owner: "installer-links", controls: () => [], execute: async context => {
    scratch = context.scratch; cleanup.add(scratch);
    await smallChild(context, `require('node:fs').writeFileSync(${JSON.stringify(join(context.scratch, "owned.pid"))},String(process.pid)); process.kill(process.ppid,'SIGKILL'); process.exit(0)`);
    expect(context.regression.safeToReuse).toBe(false);
  } }, env)).rejects.toThrow();
  const name = readdirSync(reports)[0]; if (!name) throw new Error("Missing unsafe ledger");
  expect(JSON.parse(readFileSync(join(reports, name, "ownership.json"), "utf8")).status).toBe("unsafe-retained");
  expect(existsSync(scratch)).toBe(true);
  const pid = Number(readFileSync(join(scratch, "owned.pid"), "utf8"));
  const cap = Date.now() + 10_000;
  while (linuxProcess(pid) && linuxProcess(pid)?.state !== "Z") {
    if (Date.now() > cap) throw new Error("Owned unsafe fixture child failed to exit");
    await delay(10);
  }
}, 30_000);
