import assert from "node:assert/strict";
import { navigateTestPage } from "./navigate-test-page.ts";
import { writeFileSync } from "node:fs";
import type { BrowserContext } from "playwright";
import { workerReviewCases } from "../../tests/fixtures/worker-review/cases.ts";

type Variant = "controlled" | "uncontrolled";
export interface WorkerIteration {
  variant: Variant;
  iteration: number;
  status: "planned" | "passed" | "failed" | "not-run";
  detail: string;
}
export interface WorkerModuleReport {
  browser: string;
  iterations: WorkerIteration[];
  moduleErrors: { url: string; status: number; fromServiceWorker: boolean }[];
  evalRequests: string[];
  observed: boolean;
  cleanup: { safe: boolean; error?: string };
}

/** Controlled iterations share one page. A failed context must close before the independent variant. */
export async function runWorkerModuleVariants(report: WorkerModuleReport, options: {
  open(variant: Variant): Promise<{ run(): Promise<{ passed: boolean; detail: string }> }>;
  close(): Promise<void>;
  persist(): void;
}): Promise<void> {
  options.persist();
  for (const variant of ["controlled", "uncontrolled"] as const) {
    if (!report.cleanup.safe) break;
    await runVariant(variant, report, options);
  }
  for (const row of report.iterations) if (row.status === "planned") row.status = "not-run";
  options.persist();
}
async function runVariant(variant: Variant, report: WorkerModuleReport, options: Parameters<typeof runWorkerModuleVariants>[1]): Promise<void> {
  let context: Awaited<ReturnType<typeof options.open>> | undefined;
  try {
    context = await options.open(variant);
    for (const row of report.iterations.filter(row => row.variant === variant)) {
      const checked = await context.run();
      row.status = checked.passed ? "passed" : "failed";
      row.detail = checked.detail;
      options.persist();
    }
  } catch (error) {
    const pending = report.iterations.find(row => row.variant === variant && row.status === "planned");
    if (pending) { pending.status = "failed"; pending.detail = String(error); }
  } finally {
    try { await options.close(); }
    catch (error) { report.cleanup = { safe: false, error: String(error) }; }
    for (const row of report.iterations.filter(row => row.variant === variant && row.status === "planned")) row.status = "not-run";
    options.persist();
  }
}
export function workerModuleReport(browser: string): WorkerModuleReport {
  return { browser, iterations: Array.from({ length: 20 }, (_, index): WorkerIteration => ({ variant: "controlled", iteration: index + 1, status: "planned", detail: "" }))
    .concat([{ variant: "uncontrolled", iteration: 1, status: "planned", detail: "" }]),
  moduleErrors: [], evalRequests: [], observed: false, cleanup: { safe: true } };
}
export function assertWorkerModuleReport(value: unknown, browser: string): void {
  assert.ok(value && typeof value === "object" && "browser" in value && value.browser === browser);
  assert.ok("iterations" in value && Array.isArray(value.iterations));
  const expected = workerModuleReport(browser).iterations.map(row => `${row.variant}:${row.iteration}`);
  assert.deepEqual(value.iterations.map(row => `${row.variant}:${row.iteration}`), expected, "exact 20 controlled and one uncontrolled invocation");
  assert.ok(value.iterations.every(row => row.status === "passed"), "all worker invocations passed");
  assert.ok("observed" in value && value.observed === true, "both HTTP observations completed");
  assert.ok("moduleErrors" in value); assert.deepEqual(value.moduleErrors, [], "module HTTP errors");
  assert.ok("evalRequests" in value); assert.deepEqual(value.evalRequests, [], "eval modules must not depend on HTTP");
  assert.ok("cleanup" in value && value.cleanup && typeof value.cleanup === "object" && "safe" in value.cleanup && value.cleanup.safe === true, "worker cleanup");
}

// Reproduce WebKit's uncontrolled descendant without depending on SW assignment timing.
function uncontrolledChildren() {
  const NativeWorker = globalThis.Worker;
  let root: Worker | null = null;
  let redirects = 0;
  Reflect.set(globalThis, "__bunwasmUncontrolledRedirects", 0);
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const pathname = new URL(String(args[0]), location.href).pathname;
      const match = /\/__bunwasm\/(entry-worker-[0-9a-f]+\.js|worker\.js)$/.exec(pathname);
      const scoped = match !== null;
      if (scoped && root) {
        args[0] = new URL(`./${match[1]}`, location.href).href;
        Reflect.set(globalThis, "__bunwasmUncontrolledRedirects", ++redirects);
      }
      const worker: Worker = Reflect.construct(target, args, newTarget);
      if (!scoped || root) return worker;
      root = worker;
      const terminate = worker.terminate;
      worker.terminate = () => { root = null; return terminate.call(worker); };
      return worker;
    },
  });
}
async function main(): Promise<void> {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "webkit"];
  assert.ok(names.every(name => name === "chromium" || name === "webkit") && new Set(names).size === names.length, "unsupported/duplicate browser");
  const { browserType } = await import("./browser-type.ts");
  const { session, ready, writeFile, run } = await import("./playground.mjs");
  const atomic = workerReviewCases.find(test => test.name === "atomic-transfer");
  assert.ok(atomic);
  const reports = names.map(workerModuleReport);
  const persist = () => { if (process.env.BUN_WASM_WORKER_MODULES_OUTPUT) writeFileSync(process.env.BUN_WASM_WORKER_MODULES_OUTPUT, JSON.stringify(reports, null, 2) + "\n"); };
  persist();
  const task = session("bun-wasm-worker-modules-");
  const deadline = setTimeout(() => { console.error("worker module gate timed out"); void task.cleanup().finally(() => process.exit(1)); }, 600_000);
  try {
    const url = process.env.BUN_WASM_TEST_URL ?? await task.serve();
    for (const report of reports) {
      await checkWorkerBrowser(report, task, url, atomic, persist, { browserType, ready, writeFile, run });
      if (!report.cleanup.safe) break;
    }
  } finally {
    clearTimeout(deadline);
    for (const report of reports) finalizeWorkerRecords(report);
    try { await task.cleanup(); }
    finally { persist(); }
  }
  for (const report of reports) assertWorkerModuleReport(report, report.browser);
}
function finalizeWorkerRecords(report: WorkerModuleReport): void {
  for (const row of report.iterations) if (row.status === "planned") row.status = "not-run";
}
type PlaygroundHelpers = typeof import("./playground.mjs");
async function checkWorkerBrowser(report: WorkerModuleReport, task: ReturnType<PlaygroundHelpers["session"]>, url: string,
  atomic: typeof workerReviewCases[number], persist: () => void, helpers: Pick<PlaygroundHelpers, "ready" | "writeFile" | "run"> & typeof import("./browser-type.ts")): Promise<void> {
  const browser = await task.launch(helpers.browserType(report.browser));
  let active: BrowserContext | undefined;
  let opening: Promise<BrowserContext> | undefined;
  async function close() {
    const context = active ?? await opening;
    await context?.close();
    active = undefined; opening = undefined;
  }
  async function open(variant: Variant) {
    active = await (opening = browser.newContext());
    observeModules(active, report);
    if (variant === "uncontrolled") await active.addInitScript(uncontrolledChildren);
    const page = await active.newPage();
    await navigateTestPage(page, `${url}?engine=browser&prompt=off`);
    assert.match(await helpers.ready(page), /ready/);
    await helpers.writeFile(page, "/home/user/worker-atomic.ts", atomic.code);
    let iteration = 0;
    return { async run() {
      const checked = await helpers.run(page, "bun run worker-atomic.ts", 120000);
      const redirects = variant === "uncontrolled"
        ? await page.evaluate(() => Number(Reflect.get(globalThis, "__bunwasmUncontrolledRedirects") ?? 0))
        : 0;
      const redirected = variant !== "uncontrolled" || redirects > 0;
      const passed = checked.code === atomic.exit && atomic.output.every(line => checked.output.includes(line)) && redirected;
      console.log(JSON.stringify({ browser: report.browser, variant, iteration: ++iteration, passed, redirects, ...checked }));
      return { passed, detail: JSON.stringify({ ...checked, redirects }) };
    } };
  }
  try {
    await runWorkerModuleVariants(report, { persist, open, close });
    report.observed = true;
  } finally {
    try { await close(); await browser.close(); }
    catch (error) { report.cleanup = { safe: false, error: String(error) }; }
    persist();
  }
}
function observeModules(context: BrowserContext, report: WorkerModuleReport): void {
  context.on("request", request => { if (decodeURIComponent(request.url()).endsWith("/[eval]")) report.evalRequests.push(request.url()); });
  context.on("response", response => {
    if (response.status() >= 400 && response.url().includes("/__bunwasm/m/")) report.moduleErrors.push({ url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker() });
  });
}
if (import.meta.main) await main();
