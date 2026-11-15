import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEngineInterruptionResult } from "../web/tests/engine-interruption-result";
import { selectInterruptionEngines, interruptionInputs, interruptionProofs } from "../web/tests/engine-interruption-cases";
import { assertWorkerModuleReport, runWorkerModuleVariants, workerModuleReport } from "../web/tests/browser-worker-modules";
import { runStdinCases, stdinCaseNames, stdinCaseRecords } from "../web/tests/playground-stdin";
import { assertStdinReport, stdinBrowser } from "../web/tests/browser-playground-stdin";
import { expectedBrowserGuestRows } from "./browser-guest-catalogue";
import { browserGuestManifest } from "./browser-guest-selection";

function green(engines = selectInterruptionEngines()) {
  return { ok: true, checks: interruptionProofs(engines), outcomes: [{ ok: true, cleanup: { safe: true } }], cleanup: { safe: true, activeWorkers: 0 }, benchmarks: engines.map(engine => ({ engine })) };
}
function workerFixture(unsafe: boolean, setupFailure = false) {
  const report = workerModuleReport("chromium"), events: string[] = [];
  type Variant = Parameters<Parameters<typeof runWorkerModuleVariants>[1]["open"]>[0];
  async function run(variant: Variant) {
    if (variant === "controlled") throw new Error("closed prompt");
    return { passed: true, detail: "independent" };
  }
  async function open(variant: Variant) {
    events.push(`open:${variant}`);
    if (setupFailure && variant === "controlled") throw new Error("page setup failure");
    return { run: () => run(variant) };
  }
  async function close() { events.push("drain"); if (unsafe) throw new Error("undrained"); }
  return { report, events, options: { persist() {}, open, close } };
}
function stdinFailureActions(events: string[]) {
  return stdinCaseNames.map((name, index) => async () => { events.push(name); if (index === 1) throw new Error("missing OPEN"); });
}
function stdinCleanup(events: string[], unsafe: boolean) {
  return async () => { events.push("idle"); if (unsafe) throw new Error("foreground alive"); };
}
test("interruption engine subsets retain Browser and Preview1, with the default 32 checks and 96 full proofs", () => {
  expect(green().checks).toHaveLength(32);
  expect(3 * green().checks.length).toBe(96);
  for (const engine of ["quickjs", "jsc"]) {
    const selected = selectInterruptionEngines(engine);
    expect(green(selected).checks).toHaveLength(18);
    expect(() => assertEngineInterruptionResult(green(selected), false, selected)).not.toThrow();
    expect(() => assertEngineInterruptionResult(green(selected), false)).toThrow();
    const names = green(selected).checks.map(check => check.name);
    expect(names).toContain("runtimeProcess-page-sleepSync-default-SIGUSR1-unwinds");
    expect(names).toContain("runtimeProcess-page-sleepSync-SIGUSR1-deferred-handler");
    expect(green(selected).checks.filter(check => check.engine === "browser")).toHaveLength(4);
  }
  for (const value of ["", "browser", "jsc,quickjs", "quickjs,quickjs", "quickjs,unknown"]) expect(() => selectInterruptionEngines(value)).toThrow();
  const renamed = green(); renamed.checks[0]!.name = "invented-proof";
  expect(() => assertEngineInterruptionResult(renamed, false)).toThrow("named proofs");
});
test("interruption artifact inputs require each selected pair and unchanged Browser controls", () => {
  expect(interruptionInputs(["quickjs"])).toEqual(["bun-browser.wasm", "bun.wasm", "quickjs.wasm"]);
  expect(interruptionInputs(["jsc"])).toEqual(["bun-browser.wasm", "bun-jsc.wasm", "jsc-engine.wasm"]);
  expect(interruptionInputs(selectInterruptionEngines())).toHaveLength(5);
});
test("missing explicitly selected side fails before browser launch or bundle build", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-focused-missing-"));
  try {
    const output = join(directory, "report.json");
    for (const name of ["bun-browser.wasm", "bun-jsc.wasm"]) writeFileSync(join(directory, name), "preflight-only, never executed");
    const child = Bun.spawnSync([process.execPath, new URL("../web/tests/browser-engine-interruption.ts", import.meta.url).pathname, "chromium", "--engines=jsc"], {
      env: { ...process.env, BUN_WASM_INTERRUPTION_DIST: directory, ENGINE_INTERRUPTION_OUTPUT: output }, stdout: "pipe", stderr: "pipe",
    });
    expect(child.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toContain("jsc-engine.wasm");
    const result = JSON.parse(readFileSync(output, "utf8"));
    expect(result.reports).toEqual([]);
    expect(result.cleanup.safe).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("Chromium interruption leg owns Firefox once and WebKit leg owns none", () => {
  const selection = [{ owner: "engine-interruption", engines: ["quickjs", "jsc"] }] as const;
  const chromium = expectedBrowserGuestRows(selection, "chromium"), webkit = expectedBrowserGuestRows(selection, "webkit");
  expect(chromium.map(row => row.browser)).toEqual(["chromium", "chromium", "firefox", "firefox"]);
  expect(webkit.map(row => row.browser)).toEqual(["webkit", "webkit"]);
  const wrapper = readFileSync(new URL("./engine-interruption-browser.test.ts", import.meta.url), "utf8");
  expect(wrapper).toContain('["chromium", "firefox"] : ["webkit"]');
  expect(wrapper).toContain("hangSeconds: 1400");
  expect(wrapper).not.toContain("--benchmark");
});
test("worker exact accounting retains 20 controlled invocations and one independent invocation", async () => {
  const report = workerModuleReport("webkit"), events: string[] = [];
  await runWorkerModuleVariants(report, { persist() {}, async open(variant) {
    events.push(`open:${variant}`);
    return { async run() { events.push(`run:${variant}`); return { passed: true, detail: "fixture" }; } };
  }, async close() { events.push("close"); } });
  report.observed = true;
  expect(() => assertWorkerModuleReport(report, "webkit")).not.toThrow();
  expect(events.filter(event => event === "open:controlled")).toHaveLength(1);
  expect(events.filter(event => event === "run:controlled")).toHaveLength(20);
  expect(events.indexOf("open:uncontrolled")).toBe(events.indexOf("close") + 1);
  for (const bad of [{ ...report, iterations: report.iterations.slice(1) }, { ...report, observed: false }, { ...report, evalRequests: ["/[eval]"] }, { ...report, moduleErrors: [{ url: "/__bunwasm/m/foo", status: 404, fromServiceWorker: false }] }]) expect(() => assertWorkerModuleReport(bad, "webkit")).toThrow();
});
test("worker functional failure attempts independent variant only after context drain; unsafe close stops reuse", async () => {
  for (const unsafe of [false, true]) {
    const { report, events, options } = workerFixture(unsafe);
    await runWorkerModuleVariants(report, options);
    expect(report.iterations.filter(row => row.status === "not-run")).toHaveLength(unsafe ? 20 : 19);
    expect(events).toEqual(unsafe ? ["open:controlled", "drain"] : ["open:controlled", "drain", "open:uncontrolled", "drain"]);
    expect(report.cleanup.safe).toBe(!unsafe);
  }
});
test("worker setup failure drains its partially opened context before independent variant", async () => {
  const { report, events, options } = workerFixture(false, true);
  await runWorkerModuleVariants(report, options);
  expect(events).toEqual(["open:controlled", "drain", "open:uncontrolled", "drain"]);
});
test("stdin preserves the named API and six same-terminal forms, and rejects extra browsers", () => {
  expect(stdinBrowser(["webkit"])).toBe("webkit");
  for (const names of [[], ["firefox"], ["chromium", "webkit"], ["chromium", "chromium"]]) expect(() => stdinBrowser(names)).toThrow();
  const report = { browser: "webkit", cases: stdinCaseRecords().map(row => ({ ...row, status: "passed" })), cleanup: { safe: true } };
  expect(() => assertStdinReport(report, "webkit")).not.toThrow();
  expect(() => assertStdinReport({ ...report, cases: report.cases.slice(1) }, "webkit")).toThrow();
  const source = readFileSync(new URL("../web/tests/playground-stdin.ts", import.meta.url), "utf8");
  for (const assertion of ["OPEN:${name}:true", "DATA:${name}:hello", "DATA:${name}:again", "END:${name}", "empty terminal input must not be EOF", "OPEN:pipe:false", "DATA:pipe:pipe", "END:pipe", "OPEN:file:false", "DATA:file:file", "END:file", "chmodSync", "export async function checkPlaygroundStdin"]) expect(source).toContain(assertion);
  const driver = readFileSync(new URL("../web/tests/browser-playground-stdin.ts", import.meta.url), "utf8");
  expect(driver).toContain('playwright.devices["iPhone 15"]');
  expect(driver).toContain("?prompt=off&engine=browser");
  expect(driver).not.toContain("browser-engine.mjs");
});
test("stdin failure continues only after stopping foreground and proving idle; unsafe cleanup marks remaining not-run", async () => {
  for (const unsafe of [false, true]) {
    const events: string[] = [];
    let rows = stdinCaseRecords();
    const actions = stdinFailureActions(events);
    await expect(runStdinCases(actions, stdinCleanup(events, unsafe), value => { rows = value.map(row => ({ ...row })); })).rejects.toThrow();
    expect(events[1]).toBe("idle");
    expect(rows.filter(row => row.status === "not-run")).toHaveLength(unsafe ? 5 : 0);
    expect(rows.some(row => row.status === "planned")).toBe(false);
  }
});
test("focused manifests preserve the browser-guest blocking owner, exact inputs and original assertions", () => {
  for (const owner of ["engine-interruption", "worker-modules", "terminal-stdin"] as const) {
    const manifest = JSON.parse(readFileSync(new URL(`../checks/browser-guest-${owner}.json`, import.meta.url), "utf8"));
    const expected = browserGuestManifest(owner);
    expect({ ...manifest, inputs: undefined }).toEqual({ ...expected, inputs: undefined });
    expect(manifest.inputs.toSorted()).toEqual(Array.from(new Set(expected.inputs.concat(["scripts/browser-guest-wrapper.ts"]))).sort());
    const wrapper = readFileSync(new URL(`../${manifest.path}`, import.meta.url), "utf8");
    expect(wrapper).toContain("withBrowserGuestRegression");
    expect(wrapper).toContain("3_120_000");
    expect(wrapper).toContain("runChild({ signal,");
    expect(wrapper).not.toContain("buildBrowserEntries");
  }
  const worker = readFileSync(new URL("../web/tests/browser-worker-modules.ts", import.meta.url), "utf8");
  expect(worker).toContain("atomic.output.every"); expect(worker).toContain("checked.code === atomic.exit");
  expect(worker).toContain('decodeURIComponent(request.url()).endsWith("/[eval]")');
  expect(worker).toContain('response.url().includes("/__bunwasm/m/")');
});

test("actual focused wrappers reject missing owner, invalid leg and missing selected artifacts before any browser execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-focused-boundary-"));
  try {
    for (const owner of ["engine-interruption", "worker-modules", "terminal-stdin"] as const) {
      checkWrapperBoundary(owner, directory);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function checkWrapperBoundary(owner: "engine-interruption" | "worker-modules" | "terminal-stdin", directory: string): void {
const wrapper = new URL(`../${browserGuestManifest(owner).path}`, import.meta.url).pathname;
const selection = JSON.stringify([{ owner, engines: owner === "engine-interruption" ? ["quickjs"] : ["browser"] }]);
for (const request of [
  { selection: "[]", leg: "chromium", error: /selection|owner/i },
  { selection, leg: "chromium,firefox", error: /exactly one browser/i },
  { selection, leg: "chromium", error: /site|artifact|ENOENT/i },
]) {
  const child = Bun.spawnSync([process.execPath, "test", wrapper], { env: { ...process.env,
    BUN_WASM_BROWSER_COVERAGE_SELECTION: request.selection, BUN_WASM_TEST_BROWSERS: request.leg,
    BUN_WASM_BROWSER_SITE: join(directory, "missing-site"), BUN_WASM_BROWSER_COVERAGE_REPORTS: directory,
  }, stdout: "pipe", stderr: "pipe" });
  const output = new TextDecoder().decode(child.stderr);
  expect(child.exitCode).not.toBe(0);
  expect(output).not.toContain("Cannot find module");
  expect(output).toMatch(request.error);
}
}
