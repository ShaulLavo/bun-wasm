import { chromium, firefox, type Page, type BrowserContext } from "playwright";
import type { Browser as BrowserKind } from "./catalog";
import { admit, awaitWithin, within, type Admission } from "./scope";
type EvaluationOptions = { observation: true };
interface CleanupEvidence { browserClosed: true; foregroundStopped: true; previewClosed: true }
/**
 * Admit immediately before every send, enqueue, role switch or native input, including
 * after internal waits. Withdraw waiting work when admission closes. Retain dispatched
 * work until it settles or close ends it, while bounding the caller's await by admission.
 * Teardown is unguarded and always proceeds.
 */
export interface Transport {
  readonly capabilities: Record<string, unknown>;
  beginCleanup?(admission: Admission): void | Promise<void>;
  nativeClick?(button: string, clicked: string, admission: Admission): Promise<unknown>;
  cleanup?(timeoutMs: number): Promise<CleanupEvidence>;
  navigate(url: string, admission: Admission): Promise<void>;
  evaluate<T>(expression: string, admission: Admission, options?: EvaluationOptions): Promise<T>;
  openPreview(url: string, admission: Admission): Promise<void>;
  useHost(admission: Admission): Promise<void>;
  usePreview(admission: Admission): Promise<void>;
  closePreview(admission: Admission): Promise<void>;
  close(interruptPending?: boolean, timeoutMs?: number): Promise<void>;
}
export type ScopedTransport = {
  readonly capabilities: Record<string, unknown>;
  evaluate<T>(expression: string, options?: EvaluationOptions): Promise<T>;
  navigate(url: string): Promise<void>;
  openPreview(url: string): Promise<void>;
  useHost(): Promise<void>;
  usePreview(): Promise<void>;
  closePreview(): Promise<void>;
  nativeClick?(button: string, clicked: string, timeoutMs: number): Promise<unknown>;
};
export function scoped(transport: Transport, admission: Admission): ScopedTransport {
  const call = <T>(operation: () => Promise<T>, guard = admission): Promise<T> => {
    admit(guard);
    return awaitWithin(operation(), guard);
  };
  const nativeClick = transport.nativeClick?.bind(transport);
  return {
    capabilities: transport.capabilities,
    evaluate: <T>(expression: string, options?: EvaluationOptions) => call(() => transport.evaluate<T>(expression, admission, options)),
    navigate: url => call(() => transport.navigate(url, admission)),
    openPreview: url => call(() => transport.openPreview(url, admission)),
    useHost: () => call(() => transport.useHost(admission)),
    usePreview: () => call(() => transport.usePreview(admission)),
    closePreview: () => call(() => transport.closePreview(admission)),
    ...(nativeClick ? { nativeClick: (button: string, clicked: string, timeoutMs: number) => {
      const guard = within(admission, timeoutMs, new Error(`Phase timed out after ${timeoutMs} ms`));
      return call(() => nativeClick(button, clicked, guard), guard);
    } } : {}),
  };
}
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
export async function createPlaywrightTransport(kind: Extract<BrowserKind, "chrome" | "firefox">, timeoutMs: number, cleanupTimeoutMs = timeoutMs): Promise<Transport> {
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
    return createPageTransport(context, host, { browserName: kind === "chrome" ? "chrome" : "firefox", browserVersion: browser.version(), transport: "playwright", executable: kind === "chrome" ? executablePath ?? "chrome channel" : firefox.executablePath() }, timeoutMs, cleanupTimeoutMs, () => browser.close());
  } catch (error) { await browser.close(); throw error; }
}

export function createPageTransport(context: Pick<BrowserContext, "newPage">, host: Page, capabilities: Record<string, unknown>, timeoutMs: number, cleanupTimeoutMs: number, close: () => Promise<void>): Transport {
  let preview: typeof host | undefined;
  let page = host;
  let evaluationTimeoutMs = timeoutMs;
  page.setDefaultTimeout(timeoutMs);
  return {
    capabilities,
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
