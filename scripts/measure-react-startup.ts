import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { cpus, hostname, release } from "node:os";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";

export interface StartupSample {
  revision: string;
  url: string;
  iteration: number;
  cache: "cold" | "warm";
  renderMs: number;
  interactiveMs: number;
  phases: { name: string; startMs: number; durationMs: number }[];
  requests: { url: string; status: number; bytes: number }[];
  dependencies: Record<string, string>;
  cacheMarks: string[];
}

export function median(values: readonly number[]): number {
  assert.ok(values.length > 0, "cannot summarize missing samples");
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export function checkStartupLimit(samples: readonly StartupSample[], limitMs: number): void {
  assert.ok(Number.isFinite(limitMs) && limitMs > 0, "limit must be positive and finite");
  for (const cache of ["cold", "warm"] as const) {
    const duration = median(samples.filter(sample => sample.cache === cache).map(sample => sample.renderMs));
    assert.ok(duration <= limitMs, `${cache} React render ${duration.toFixed(1)} ms exceeds ${limitMs} ms`);
  }
}

export async function renderedReact(page: Page): Promise<{ renderMs: number; interactiveMs: number }> {
  const preview = page.frameLocator("#preview");
  await preview.getByRole("heading", { name: "Hello from bun.wasm", exact: true }).waitFor({ state: "visible" });
  await preview.getByRole("button", { name: "count is 0", exact: true }).waitFor({ state: "visible" });
  await preview.locator("#root").evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const renderMs = await page.evaluate(() => performance.now());
  await preview.getByRole("button", { name: "count is 0", exact: true }).click();
  await preview.getByRole("button", { name: "count is 1", exact: true }).waitFor({ state: "visible" });
  return { renderMs, interactiveMs: await page.evaluate(() => performance.now()) };
}

async function measure(page: Page, options: { revision: string; url: string; iteration: number; cache: StartupSample["cache"] }): Promise<StartupSample> {
  const requests: StartupSample["requests"] = [];
  const capture = (response: import("playwright").Response) => {
    requests.push({ url: response.url(), status: response.status(), bytes: Number(response.headers()["content-length"] ?? 0) });
  };
  page.on("response", capture);
  try {
    if (options.cache === "cold") await page.goto(options.url, { waitUntil: "domcontentloaded" });
    else await page.reload({ waitUntil: "domcontentloaded" });
    const timing = await renderedReact(page);
    const phases = await page.evaluate(() => performance.getEntriesByType("measure").map(entry => ({ name: entry.name, startMs: entry.startTime, durationMs: entry.duration })));
    const dependencies = await resolvedDependencies(page);
    const cacheMarks = await page.evaluate(() => performance.getEntriesByType("mark").map(entry => entry.name).filter(name => name.includes("cache")));
    return { ...options, ...timing, phases, requests, dependencies, cacheMarks };
  } finally { page.off("response", capture); }
}

async function resolvedDependencies(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const sandbox: unknown = Reflect.get(globalThis, "sandbox");
    if (!sandbox || typeof sandbox !== "object") throw new Error("Missing sandbox");
    const fs: unknown = Reflect.get(sandbox, "fs");
    if (!fs || typeof fs !== "object") throw new Error("Missing sandbox filesystem");
    const read: unknown = Reflect.get(fs, "readFile");
    if (typeof read !== "function") throw new Error("Missing sandbox readFile");
    const dependencies: Record<string, string> = {};
    for (const name of ["react", "react-dom", "vite", "@vitejs/plugin-react"]) {
      const bytes: unknown = await read.call(fs, `/home/user/app/node_modules/${name}/package.json`);
      if (!(bytes instanceof Uint8Array)) throw new Error(`Missing installed ${name}`);
      const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string") throw new Error(`Missing ${name} version`);
      dependencies[name] = manifest.version;
    }
    return dependencies;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    url: { type: "string" }, baseline: { type: "string" }, revision: { type: "string", default: "current" },
    "baseline-revision": { type: "string", default: "previous" }, output: { type: "string" },
    samples: { type: "string", default: "3" }, "deadline-ms": { type: "string", default: "120000" },
    "limit-ms": { type: "string" }, headed: { type: "boolean", default: false },
  } });
  assert.ok(values.url && values.output, "--url and --output are required");
  const samples = Number(values.samples), deadline = Number(values["deadline-ms"]);
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 20, "samples must be 1 to 20");
  assert.ok(Number.isFinite(deadline) && deadline > 0 && deadline <= 300_000, "deadline must be at most 300000 ms");
  const limit = values["limit-ms"] === undefined ? undefined : Number(values["limit-ms"]);
  assert.ok(limit === undefined || Number.isFinite(limit) && limit > 0, "limit must be positive and finite");
  const launchArgs = values.headed && process.env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : [];
  const variants = [{ revision: values.revision, url: values.url }].concat(values.baseline ? [{ revision: values["baseline-revision"], url: values.baseline }] : []);
  for (const variant of variants) new URL(variant.url);
  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;
  let cleaning: Promise<void> | undefined;
  const rows: StartupSample[] = [];
  const errors: string[] = [];
  const cleanup = () => cleaning ??= (async () => { await (browser ?? await launching?.catch(() => undefined))?.close(); })();
  const save = async () => writeFile(values.output!, JSON.stringify({
    date: new Date().toISOString(), host: hostname(), cpu: cpus()[0]?.model, kernel: release(), bun: Bun.version,
    browser: browser?.version(), headed: values.headed, launchArgs, variants,
    method: "Real unmodified React template. Cold fresh context, then warm reload in the same context. Each pair closes its context. Alternating revision order. No OS cache flush or network interception. Render requires visible heading, zero counter and two animation frames; interaction requires counter increment.",
    samples: rows, errors, cleanup: { browserClosed: !browser?.isConnected() },
  }, null, 2) + "\n");
  const interrupt = () => { errors.push("interrupted or total deadline exceeded"); void cleanup().then(save).finally(() => process.exit(1)); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, interrupt);
  const timer = setTimeout(interrupt, samples * variants.length * deadline * 2 + 30_000);
  try {
    launching = chromium.launch({ headless: !values.headed, args: launchArgs });
    browser = await launching;
    for (let iteration = 0; iteration < samples; iteration++) {
      await measureIteration(browser, iteration);
    }
    assert.deepEqual(errors, [], "startup must not produce page errors");
    if (limit !== undefined) checkStartupLimit(rows.filter(row => row.revision === values.revision), limit);
  } catch (error) { errors.push(String(error)); throw error; }
  finally { clearTimeout(timer); await cleanup(); await save(); }

  async function measureIteration(browser: Browser, iteration: number): Promise<void> {
    for (const variant of iteration % 2 ? variants.toReversed() : variants) await measurePair(browser, variant, iteration);
  }
  async function measurePair(browser: Browser, variant: typeof variants[number], iteration: number): Promise<void> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "allow" });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(deadline);
      page.setDefaultNavigationTimeout(deadline);
      page.on("console", message => console.error(`[${variant.revision}] ${message.text()}`));
      page.on("response", response => { if (response.status() >= 400) console.error(`HTTP ${response.status()} ${response.url()}`); });
      page.on("pageerror", error => errors.push(`${variant.revision}: ${error.message}`));
      for (const cache of ["cold", "warm"] as const) await record(page, { ...variant, iteration, cache });
    } finally { await context.close(); }
  }
  async function record(page: Page, options: Parameters<typeof measure>[1]): Promise<void> {
    console.error(`React startup ${options.revision} ${options.iteration + 1} ${options.cache}`);
    try {
      const sample = await measure(page, options);
      rows.push(sample);
      await save();
      console.error(`React rendered ${sample.renderMs.toFixed(1)} ms; interactive ${sample.interactiveMs.toFixed(1)} ms`);
    } catch (error) {
      errors.push(JSON.stringify({ frames: await Promise.all(page.frames().map(async frame => ({ url: frame.url(), text: await frame.locator("body").innerText({ timeout: 1000 }).catch(String) }))), page: await page.evaluate(() => ({
        status: document.querySelector("#status")?.textContent,
        terminal: document.querySelector(".xterm-rows")?.textContent,
        frames: Array.from(document.querySelectorAll("iframe"), frame => ({ url: frame.src })),
        phases: performance.getEntriesByType("measure").map(entry => ({ name: entry.name, duration: entry.duration })),
      })).catch(() => "diagnostics unavailable") }));
      throw error;
    }
  }
}

if (import.meta.main) await main();
