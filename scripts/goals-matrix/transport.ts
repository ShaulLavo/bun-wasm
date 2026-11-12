import { chromium, firefox, type Page } from "playwright";
import type { Browser as BrowserKind } from "./catalog";
type EvaluationOptions = { observation: true };
interface CleanupEvidence { browserClosed: true; foregroundStopped: true; previewClosed: true }
export interface Transport {
  readonly capabilities: Record<string, unknown>;
  readonly processRoot?: number;
  beginCleanup?(): void | Promise<void>;
  nativeClick?(button: string, clicked: string, timeoutMs: number): Promise<unknown>;
  cleanup?(timeoutMs: number): Promise<CleanupEvidence>;
  navigate(url: string): Promise<void>;
  evaluate<T>(expression: string, options?: EvaluationOptions): Promise<T>;
  openPreview(url: string): Promise<void>;
  useHost(): Promise<void>;
  usePreview(): Promise<void>;
  closePreview(): Promise<void>;
  close(interruptPending?: boolean, timeoutMs?: number): Promise<void>;
}
export async function evaluatePage<T>(page: Page, expression: string, timeoutMs: number, options?: EvaluationOptions): Promise<T> {
  if (!options?.observation) return page.evaluate(expression);
  const handle = await page.waitForFunction(`(async () => JSON.stringify({ value: await (${expression}) }))()`, undefined, { timeout: timeoutMs });
  try {
    const serialized = await handle.jsonValue();
    if (typeof serialized !== "string") throw new Error("DOM observation returned no serialized value");
    return JSON.parse(serialized).value;
  }
  finally { await handle.dispose(); }
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
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const host = await context.newPage();
    let preview: typeof host | undefined;
    let page = host;
    let evaluationTimeoutMs = timeoutMs;
    page.setDefaultTimeout(timeoutMs);
    return {
      processRoot: server?.process().pid,
      capabilities: { browserName: kind === "chrome" ? "chrome" : "firefox", browserVersion: browser.version(), transport: "playwright", executable: kind === "chrome" ? executablePath ?? "chrome channel" : firefox.executablePath() },
      beginCleanup() { evaluationTimeoutMs = cleanupTimeoutMs; },
      async navigate(url) { await host.goto(url, { timeout: timeoutMs }); page = host; },
      evaluate: (expression, options) => evaluatePage(page, expression, evaluationTimeoutMs, options),
      async openPreview(url) {
        if (preview) await preview.close();
        preview = await context.newPage(); page = preview;
        await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      },
      async useHost() { page = host; },
      async usePreview() { if (!preview) throw new Error("No owned preview"); page = preview; },
      async closePreview() { if (preview) await preview.close(); preview = undefined; page = host; },
      async close() { try { await browser.close(); } finally { await server?.close(); } },
    };
  } catch (error) { try { await browser.close(); } finally { await server?.close(); } throw error; }
}
