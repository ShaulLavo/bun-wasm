import { chromium, firefox } from "playwright";
import type { Browser as BrowserKind } from "./catalog";
export interface Transport {
  readonly capabilities: Record<string, unknown>;
  navigate(url: string): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
  openPreview(url: string): Promise<void>;
  useHost(): Promise<void>;
  usePreview(): Promise<void>;
  closePreview(): Promise<void>;
  close(): Promise<void>;
}
export async function createPlaywrightTransport(kind: Extract<BrowserKind, "chrome" | "firefox">, timeoutMs: number): Promise<Transport> {
  const browser = await (kind === "chrome" ? chromium.launch({ channel: "chrome", headless: true }) : firefox.launch({ headless: true }));
  try {
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const host = await context.newPage();
    let preview: typeof host | undefined;
    let page = host;
    page.setDefaultTimeout(timeoutMs);
    return {
      capabilities: { browserName: kind === "chrome" ? "chrome" : "firefox", browserVersion: browser.version(), transport: "playwright", executable: kind === "chrome" ? "chrome channel" : firefox.executablePath() },
      async navigate(url) { await host.goto(url, { timeout: timeoutMs }); page = host; },
      evaluate: expression => page.evaluate(expression),
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
