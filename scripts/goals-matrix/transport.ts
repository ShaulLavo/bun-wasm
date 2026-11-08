import { chromium, firefox, type Page } from "playwright";
import type { Browser as BrowserKind } from "./catalog";
type EvaluationOptions = { observation: true };
export interface Transport {
  readonly capabilities: Record<string, unknown>;
  navigate(url: string): Promise<void>;
  evaluate<T>(expression: string, options?: EvaluationOptions): Promise<T>;
  openPreview(url: string): Promise<void>;
  useHost(): Promise<void>;
  usePreview(): Promise<void>;
  closePreview(): Promise<void>;
  close(): Promise<void>;
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
export async function createPlaywrightTransport(kind: Extract<BrowserKind, "chrome" | "firefox">, timeoutMs: number): Promise<Transport> {
  const executablePath = process.env.GOALS_CHROME_EXECUTABLE;
  if (kind === "chrome" && executablePath) {
    const version = Bun.spawn([executablePath, "--version"], { stdout: "pipe", timeout: 5000 });
    const name = await new Response(version.stdout).text();
    if (await version.exited !== 0 || !name.startsWith("Google Chrome ")) throw new Error(`Expected genuine Google Chrome, received ${name}`);
  }
  const browser = await (kind === "chrome" ? chromium.launch({ ...(executablePath ? { executablePath } : { channel: "chrome" }), headless: true, timeout: timeoutMs }) : firefox.launch({ headless: true, timeout: timeoutMs }));
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const host = await context.newPage();
    let preview: typeof host | undefined;
    let page = host;
    page.setDefaultTimeout(timeoutMs);
    return {
      capabilities: { browserName: kind === "chrome" ? "chrome" : "firefox", browserVersion: browser.version(), transport: "playwright", executable: kind === "chrome" ? executablePath ?? "chrome channel" : firefox.executablePath() },
      async navigate(url) { await host.goto(url, { timeout: timeoutMs }); page = host; },
      evaluate: (expression, options) => evaluatePage(page, expression, timeoutMs, options),
      async openPreview(url) {
        if (preview) await preview.close();
        preview = await context.newPage(); page = preview;
        await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      },
      async useHost() { page = host; },
      async usePreview() { if (!preview) throw new Error("No owned preview"); page = preview; },
      async closePreview() { if (preview) await preview.close(); preview = undefined; page = host; },
      async close() { await browser.close(); },
    };
  } catch (error) { await browser.close(); throw error; }
}
