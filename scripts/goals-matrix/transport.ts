import { chromium, firefox, type Page, type BrowserContext } from "playwright";
import type { Browser as BrowserKind } from "./catalog";
import { admit, awaitWithin, type Admission } from "./scope";
import type { EvaluationOptions, Transport } from "./scoped-transport";
import { armNativeClick, observeNativeClick } from "./native-click";
import { until } from "./playground";
export type { Transport, ScopedTransport } from "./scoped-transport";
export { scoped } from "./scoped-transport";
export async function evaluatePage<T>(page: Page, expression: string, timeoutMs: number, admission: Admission, options?: EvaluationOptions): Promise<T> {
  admit(admission);
  if (!options?.observation) return page.evaluate(expression);
  const handle = await page.waitForFunction(`(async () => JSON.stringify({ value: await (${expression}) }))()`, undefined, { timeout: timeoutMs });
  try {
    admit(admission);
    const serialized = await handle.jsonValue();
    if (typeof serialized !== "string") throw new Error("DOM observation returned no serialized value");
    return JSON.parse(serialized).value;
  }
  finally { await handle.dispose(); }
}
async function clickPage(page: Page, button: string, clicked: string, admission: Admission): Promise<unknown> {
  const input = { button, clicked, token: crypto.randomUUID() };
  const arm = `(${armNativeClick.toString()})(${JSON.stringify(input)})`;
  const before = await until(() => evaluatePage<ReturnType<typeof armNativeClick>>(page, arm, admit(admission), admission), value => value.ready, admit(admission));
  if (!before.ready) throw new Error("Counter is not ready");
  const target = page.locator(button).first();
  await target.click({ trial: true, timeout: admit(admission) });
  admit(admission);
  const box = await target.boundingBox({ timeout: admit(admission) });
  if (!box) throw new Error("Counter has no visible bounds");
  admit(admission);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const observation = `(${observeNativeClick.toString()})(${JSON.stringify(input)})`;
  const expected = before.before.replace(/\b0\b/, "1");
  const after = await until(() => evaluatePage<ReturnType<typeof observeNativeClick>>(page, observation, admit(admission), admission), value => value.trusted && value.after === expected, admit(admission));
  return { before: before.before, after: after.after, trusted: true, inputMethod: "Playwright mouse click" };
}
export async function createPlaywrightTransport(kind: Extract<BrowserKind, "chrome" | "firefox">, timeoutMs: number, cleanupTimeoutMs = timeoutMs, scopedProcess = false): Promise<Transport> {
  const executablePath = process.env.GOALS_CHROME_EXECUTABLE;
  if (kind === "chrome" && executablePath) {
    const version = Bun.spawn([executablePath, "--version"], { stdout: "pipe", timeout: 5000 });
    const name = await new Response(version.stdout).text();
    if (await version.exited !== 0 || !name.startsWith("Google Chrome ")) throw new Error(`Expected genuine Google Chrome, received ${name}`);
  }
  const browserType = kind === "chrome" ? chromium : firefox;
  const launch = kind === "chrome" ? { ...(executablePath ? { executablePath } : { channel: "chrome" }), headless: true, timeout: timeoutMs } : { headless: true, timeout: timeoutMs };
  const server = scopedProcess ? await browserType.launchServer(launch) : null;
  const browser = server ? await browserType.connect(server.wsEndpoint()).catch(async error => { await server.close(); throw error; }) : await browserType.launch(launch);
  const close = async () => { try { await browser.close(); } finally { await server?.close(); } };
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const host = await context.newPage();
    return {
      ...createPageTransport(context, host, { browserName: kind === "chrome" ? "chrome" : "firefox", browserVersion: browser.version(), transport: "playwright", executable: kind === "chrome" ? executablePath ?? "chrome channel" : firefox.executablePath() }, timeoutMs, cleanupTimeoutMs, close),
      processRoot: server?.process().pid,
    };
  } catch (error) { await close(); throw error; }
}

export function createPageTransport(context: Pick<BrowserContext, "newPage">, host: Page, capabilities: Record<string, unknown>, timeoutMs: number, cleanupTimeoutMs: number, close: () => Promise<void>): Transport {
  let preview: typeof host | undefined;
  let page = host;
  let evaluationTimeoutMs = timeoutMs;
  page.setDefaultTimeout(timeoutMs);
  return {
    capabilities,
    async nativeClick(button, clicked, admission) {
      admit(admission);
      return awaitWithin(clickPage(page, button, clicked, admission), admission);
    },
    beginCleanup(admission) { admit(admission); evaluationTimeoutMs = cleanupTimeoutMs; },
    async navigate(url, admission) {
      admit(admission);
      return awaitWithin((async () => { await host.goto(url, { timeout: timeoutMs }); admit(admission); page = host; })(), admission);
    },
    async evaluate(expression, admission, options) { admit(admission); return awaitWithin(evaluatePage(page, expression, evaluationTimeoutMs, admission, options), admission); },
    async openPreview(url, admission) {
      admit(admission);
      return awaitWithin(openPreview(url, admission), admission);
    },
    async useHost(admission) { admit(admission); page = host; },
    async usePreview(admission) { admit(admission); if (!preview) throw new Error("No owned preview"); page = preview; },
    async closePreview(admission) {
      admit(admission);
      return awaitWithin(closePreview(admission), admission);
    },
    async close() { await close(); },
  };
  async function openPreview(url: string, admission: Admission): Promise<void> {
    if (preview) await preview.close();
    admit(admission);
    preview = await context.newPage();
    admit(admission);
    page = preview;
    await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  }
  async function closePreview(admission: Admission): Promise<void> {
    if (preview) await preview.close();
    preview = undefined;
    admit(admission);
    page = host;
  }
}
