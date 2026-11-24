// Chrome check of a deployed sandbox: tests the actual `/` root sandbox landing page on default
// persistent FS (including full reload on the same profile), plus the iPhone smoke's three
// `/playground/` cells, in Chrome for Testing against the live origin.
// Usage: bun scripts/chrome-live-smoke.ts --output=DIR [--base-url=https://bun.sprockt.dev/] [--timeout-ms=N]
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type ConsoleMessage, type Page } from "playwright";
import { frameworks, type Box, type Framework } from "./goals-matrix/catalog";
import { execute } from "./goals-matrix/execute";
import type { Cell, PhaseResult } from "./goals-matrix/model";
import { playgroundURL } from "./goals-matrix/run";
import { createPlaywrightTransport } from "./goals-matrix/transport";
import { smokeCases, smokePhases } from "./iphone-smoke/cases";
import { templateProfile } from "../web/src/playground/program-profile";

export interface LiveSmokeOptions {
  base: URL;
  output: string;
  timeoutMs: number;
  installTimeoutMs: number;
}
interface Deployment { sourceCommit: string; waffleVersion: string }
interface CellResult { box: Box; url: string; smokeGreen: boolean; summary: string; cell: Cell }
export interface SandboxRootResult {
  url: string;
  smokeGreen: boolean;
  initialMs?: number;
  reloadMs?: number;
  databases?: string[];
  errors: string[];
  missingUrls: string[];
}

const usage = "Usage: bun scripts/chrome-live-smoke.ts --output=DIR [--base-url=URL] [--timeout-ms=N] [--install-timeout-ms=N]";

// Timers wrap above a signed 32-bit millisecond count (2147483648 ms fires after 1 ms).
const maxTimerMs = 2_147_483_647;

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer, not ${JSON.stringify(value)}`);
  if (parsed > maxTimerMs) throw new Error(`--${name} must be at most ${maxTimerMs} ms, not ${value}`);
  return parsed;
}

export function liveSmokeOptions(argv: readonly string[]): LiveSmokeOptions {
  const { values } = parseArgs({
    args: argv.slice(), strict: true, allowPositionals: false,
    options: {
      "base-url": { type: "string", default: "https://bun.sprockt.dev/" },
      output: { type: "string" },
      "timeout-ms": { type: "string", default: "300000" },
      "install-timeout-ms": { type: "string", default: "600000" },
    },
  });
  if (!values.output) throw new Error(usage);
  const base = new URL(values["base-url"]);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error(`--base-url must be an http(s) URL: ${base.href}`);
  return {
    base, output: resolve(values.output),
    timeoutMs: positiveInteger(values["timeout-ms"], "timeout-ms"),
    installTimeoutMs: positiveInteger(values["install-timeout-ms"], "install-timeout-ms"),
  };
}

/** The iPhone smoke's cells, in Chrome. */
export function chromeCells(): Box[] {
  return smokeCases.map(box => ({ ...box, browser: "chrome" }));
}

/**
 * The deploy gate judges the iPhone smoke's phases, cleanup included. Later phases (hot reload, build,
 * preview) are recorded in the summary but never judged.
 */
export function smokeGreen(phases: readonly PhaseResult[]): boolean {
  return smokePhases.every(name => phases.some(result => result.phase === name && result.status === "pass"));
}

export function phaseSummary(phases: readonly PhaseResult[]): string {
  return phases.map(result => `${result.phase}:${result.status}`).join(" ");
}

export function overallStatus(
  results: readonly Pick<CellResult, "smokeGreen">[],
  sandboxRoot?: Pick<SandboxRootResult, "smokeGreen">,
): "green" | "red" {
  return results.length > 0
    && results.every(result => result.smokeGreen)
    && (sandboxRoot === undefined || sandboxRoot.smokeGreen)
    ? "green" : "red";
}

export function parseDeployment(value: unknown): Deployment {
  if (typeof value !== "object" || value === null) throw new Error("deployment.json is not an object");
  const { sourceCommit, waffleVersion } = value as Record<string, unknown>;
  if (typeof sourceCommit !== "string" || typeof waffleVersion !== "string") throw new Error("deployment.json lacks sourceCommit or waffleVersion");
  return { sourceCommit, waffleVersion };
}

export async function fetchDeployment(base: URL, timeoutMs: number): Promise<Deployment> {
  const response = await fetch(new URL("/deployment.json", base), { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GET /deployment.json answered ${response.status}`);
  return parseDeployment(await response.json());
}

function frameworkFor(box: Box): Framework {
  const framework = frameworks.find(item => item.id === box.framework);
  if (!framework) throw new Error(`Unknown framework ${box.framework}`);
  return framework;
}

async function runCell(box: Box, options: LiveSmokeOptions): Promise<CellResult> {
  const framework = frameworkFor(box);
  const url = playgroundURL(new URL("/playground/", options.base).href, framework, box.engine);
  const name = `${box.framework}-${box.engine}`;
  const cell = await execute({
    box, framework, url, profile: templateProfile(box.engine, framework.template), port: 5173,
    timeoutMs: options.timeoutMs, installTimeoutMs: options.installTimeoutMs,
    createTransport: () => createPlaywrightTransport("chrome", options.timeoutMs, 10_000),
    saveLog: async text => { await writeFile(join(options.output, "logs", `${name}.log`), text); },
  });
  const phases = cell.attempts.at(-1)?.phases ?? [];
  const result = { box, url, smokeGreen: smokeGreen(phases), summary: phaseSummary(phases), cell };
  console.log(name, result.smokeGreen ? "smoke-pass" : "smoke-fail", result.summary);
  return result;
}

/** A reused output directory must not keep an earlier run's verdict or logs if this run fails. */
async function freshOutput(output: string): Promise<void> {
  await rm(join(output, "result.json"), { force: true });
  await rm(join(output, "logs"), { recursive: true, force: true });
  await mkdir(join(output, "logs"), { recursive: true });
}

function isRecoveredPreview502Console(message: ConsoleMessage): boolean {
  return /Failed to load resource:.*502/.test(message.text());
}

async function waitForRootSandboxReady(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(() => {
    const status = document.querySelector<HTMLElement>("#status");
    if (status?.dataset.kind === "error") throw new Error(`Root sandbox error: ${status.textContent}`);
    const dot = document.querySelector("#server-dot")?.getAttribute("data-state");
    const frame = document.querySelector<HTMLIFrameElement>("#preview");
    const button = frame?.contentDocument?.querySelector<HTMLButtonElement>("button.counter:not([disabled])");
    return status?.dataset.kind === "ok" && /dev server ready/.test(status.textContent ?? "") && dot === "up" && Boolean(button);
  }, undefined, { timeout: timeoutMs });
  const counter = page.frameLocator("#preview").locator("button.counter:not([disabled])");
  const before = (await counter.textContent({ timeout: timeoutMs })) ?? "";
  if (!/count is 0/.test(before)) throw new Error(`Unexpected root sandbox counter text before click: ${before}`);
  await counter.click({ timeout: timeoutMs });
  const after = (await counter.textContent({ timeout: timeoutMs })) ?? "";
  if (!/count is 1/.test(after)) throw new Error(`Root sandbox counter did not increment after click: ${after}`);
}

/**
 * Verifies the actual `/` landing page on default persistent IndexedDB storage (not `mode=memory`),
 * including a full page reload on the same browser profile.
 */
async function runSandboxRoot(options: LiveSmokeOptions): Promise<SandboxRootResult> {
  const url = options.base.href;
  const errors: string[] = [];
  const missingUrls: string[] = [];
  const executablePath = process.env.GOALS_CHROME_EXECUTABLE;
  let profileDir: string | undefined;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    profileDir = await mkdtemp(join(tmpdir(), "bun-wasm-chrome-live-root-"));
    context = await chromium.launchPersistentContext(profileDir, {
      ...(executablePath ? { executablePath } : { channel: "chrome" }),
      headless: true,
      timeout: options.timeoutMs,
      serviceWorkers: "allow",
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error" && !isRecoveredPreview502Console(message)) errors.push(`console: ${message.text()}`);
    });
    page.on("response", response => {
      const responseUrl = response.url();
      if (!responseUrl.startsWith(options.base.origin)) return;
      const isPreview = new URL(responseUrl).pathname.includes("/__preview/");
      if (response.status() === 404 && !isPreview) missingUrls.push(responseUrl);
      else if (response.status() >= 500 && !isPreview) errors.push(`http ${response.status()}: ${responseUrl}`);
    });
    const budget = Math.max(options.timeoutMs, options.installTimeoutMs);
    const markerPath = "/home/user/app/.chrome-smoke-marker";
    const marker = `chrome-root-${crypto.randomUUID()}`;
    const initialStart = performance.now();
    await page.goto(url, { timeout: options.timeoutMs });
    await waitForRootSandboxReady(page, budget);
    const initialMs = Math.round(performance.now() - initialStart);
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).filter((name): name is string => typeof name === "string"));
    if (!databases.includes("bun-wasm-sandbox-vite-react")) errors.push(`Missing persistent sandbox database; saw ${JSON.stringify(databases)}`);
    await page.evaluate(async ({ path, text }) => {
      const api = (globalThis as unknown as { sandbox: { fs: { writeFile(p: string, data: string): Promise<void>; flush(p?: string): Promise<void> } } }).sandbox;
      await api.fs.writeFile(path, text);
      await api.fs.flush(path);
    }, { path: markerPath, text: marker });

    const reloadStart = performance.now();
    await page.reload({ timeout: options.timeoutMs });
    await waitForRootSandboxReady(page, options.timeoutMs);
    const reloadMs = Math.round(performance.now() - reloadStart);
    const persisted = await page.evaluate(async (path: string) => {
      const api = (globalThis as unknown as { sandbox: { fs: { readFile(p: string): Promise<Uint8Array>; remove(p: string): Promise<void>; flush(): Promise<void> } } }).sandbox;
      const text = new TextDecoder().decode(await api.fs.readFile(path));
      await api.fs.remove(path);
      await api.fs.flush();
      return text;
    }, markerPath);
    if (persisted !== marker) errors.push(`Persisted marker mismatch after reload: expected ${marker}, got ${persisted}`);
    const smokeGreen = errors.length === 0 && missingUrls.length === 0;
    const result: SandboxRootResult = { url, smokeGreen, initialMs, reloadMs, databases, errors, missingUrls };
    console.log("sandbox-root", smokeGreen ? "smoke-pass" : "smoke-fail", `initial:${initialMs}ms reload:${reloadMs}ms errors:${errors.length} missing:${missingUrls.length}`);
    await writeFile(join(options.output, "logs", "sandbox-root.log"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    const result: SandboxRootResult = { url, smokeGreen: false, errors, missingUrls };
    console.log("sandbox-root", "smoke-fail", errors.join("; "));
    await writeFile(join(options.output, "logs", "sandbox-root.log"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    await context?.close().catch(() => {});
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runLiveSmoke(options: LiveSmokeOptions): Promise<"green" | "red"> {
  await freshOutput(options.output);
  const deployment = await fetchDeployment(options.base, options.timeoutMs);
  const sandboxRoot = await runSandboxRoot(options);
  const results: CellResult[] = [];
  // One cell at a time: each owns a whole browser and the shared preview port.
  for (const box of chromeCells()) results.push(await runCell(box, options));
  const status = overallStatus(results, sandboxRoot);
  await writeFile(join(options.output, "result.json"), JSON.stringify({ status, base: options.base.href, judgedPhases: smokePhases, deployment, sandboxRoot, results }, null, 2) + "\n");
  console.log(JSON.stringify({ status, sourceCommit: deployment.sourceCommit }));
  return status;
}

if (import.meta.main) {
  const status = await runLiveSmoke(liveSmokeOptions(process.argv.slice(2)));
  process.exit(status === "green" ? 0 : 1);
}
