import { chromium, firefox, type Browser, type Page, type CDPSession } from "playwright";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { evaluatePage, type Transport } from "../goals-matrix/transport";
import { bounded } from "../goals-matrix/bounded";

export type ProfileBrowser = "chrome" | "firefox";
export async function profileTransport(kind: ProfileBrowser, output: string, enabled: boolean, timeoutMs: number) {
  const executablePath = process.env.GOALS_CHROME_EXECUTABLE;
  if (kind === "chrome" && !executablePath) throw new Error("Set GOALS_CHROME_EXECUTABLE to genuine Google Chrome");
  const browser = kind === "chrome"
    ? await chromium.launch({ executablePath, headless: true, timeout: timeoutMs })
    : await firefox.launch({ headless: true, timeout: timeoutMs, env: { ...process.env, ...(enabled ? {
      MOZ_PROFILER_STARTUP: "1", MOZ_PROFILER_SHUTDOWN: join(output, "gecko.json"), MOZ_PROFILER_STARTUP_INTERVAL: "5",
      MOZ_PROFILER_STARTUP_ENTRIES: "8000000", MOZ_PROFILER_STARTUP_FEATURES: "js,cpu",
      MOZ_PROFILER_STARTUP_FILTERS: "DOM Worker,GeckoMain,JS Helper",
    } : {}) } });
  try { return await opened(browser, kind, output, enabled, timeoutMs); }
  catch (error) { await browser.close(); throw error; }
}

async function opened(browser: Browser, kind: ProfileBrowser, output: string, enabled: boolean, timeoutMs: number) {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const host = await context.newPage();
  let page = host;
  let preview: Page | undefined;
  const workers: { event: "born" | "exited"; url: string; at: number }[] = [];
  host.on("worker", worker => {
    workers.push({ event: "born", url: worker.url(), at: Date.now() });
    worker.on("close", () => workers.push({ event: "exited", url: worker.url(), at: Date.now() }));
  });
  const transport: Transport = {
    capabilities: { browserName: kind, browserVersion: browser.version(), executable: kind === "chrome" ? process.env.GOALS_CHROME_EXECUTABLE : firefox.executablePath(), headless: true },
    async navigate(url) { await host.goto(url, { timeout: timeoutMs }); page = host; },
    evaluate: (source, options) => evaluatePage(page, source, timeoutMs, options),
    async openPreview(url) { preview = await context.newPage(); page = preview; await page.goto(url, { timeout: timeoutMs }); },
    async useHost() { page = host; },
    async usePreview() { if (!preview) throw new Error("Missing preview"); page = preview; },
    async closePreview() { await preview?.close(); preview = undefined; page = host; },
    async close() { await bounded(() => browser.close(), 15000); },
  };
  return { transport, workers, capture: async () => enabled && kind === "chrome" ? trace(browser, output) : async () => {} };
}

async function trace(browser: Browser, output: string) {
  const session = await browser.newBrowserCDPSession();
  const targets: { event: "born" | "exited"; id: string; at: number; type?: string; url?: string }[] = [];
  const annotationErrors: string[] = [];
  let requestId = 0;
  session.on("Target.targetCreated", ({ targetInfo }) => {
    targets.push({ event: "born", id: targetInfo.targetId, type: targetInfo.type, url: targetInfo.url, at: Date.now() });
    if (targetInfo.type !== "worker") return;
    void annotate(targetInfo.targetId).catch(error => annotationErrors.push(String(error)));
  });
  async function annotate(targetId: string) {
    const attached = await session.send("Target.attachToTarget", { targetId, flatten: false });
    await session.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id: ++requestId, method: "Runtime.evaluate",
      params: { expression: `console.timeStamp(${JSON.stringify("lifecycle-profile-target:" + targetId)})` } }) });
  }
  session.on("Target.targetDestroyed", ({ targetId }) => targets.push({ event: "exited", id: targetId, at: Date.now() }));
  await session.send("Target.setDiscoverTargets", { discover: true });
  const completed = new Promise<string>((resolve, reject) => session.once("Tracing.tracingComplete", event => {
    if (event.stream) resolve(event.stream); else reject(new Error("Trace stream unavailable"));
  }));
  void completed.catch(() => {});
  await session.send("Tracing.start", { categories: "disabled-by-default-v8.cpu_profiler,devtools.timeline", transferMode: "ReturnAsStream" });
  return async () => {
    await session.send("Tracing.end");
    const handle = await bounded(() => completed, 60000);
    try {
      await writeFile(join(output, "chrome-trace.json"), await readTrace(session, handle));
      await writeFile(join(output, "chrome-targets.json"), JSON.stringify(targets));
      await writeFile(join(output, "chrome-annotation-errors.json"), JSON.stringify(annotationErrors));
    } finally { await session.send("IO.close", { handle }); await session.detach(); }
  };
}

async function readTrace(session: CDPSession, handle: string) {
  const parts: string[] = [];
  let eof = false;
  while (!eof) {
    const part = await bounded(() => session.send("IO.read", { handle }), 15000);
    if (part.base64Encoded) throw new Error("Unexpected encoded trace stream");
    parts.push(part.data); eof = part.eof ?? false;
  }
  return parts.join("");
}
