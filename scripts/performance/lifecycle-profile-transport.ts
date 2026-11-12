import { chromium, firefox, type Browser, type CDPSession } from "playwright";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createPageTransport } from "../goals-matrix/transport";
import { geckoCollectorConfig } from "./lifecycle-profile-config";
import { bounded } from "../goals-matrix/bounded";
import { chromeTraceConfig, type BufferUsage, type TracingComplete } from "./lifecycle-profile-retention";

export type ProfileBrowser = "chrome" | "firefox";
export async function profileTransport(kind: ProfileBrowser, output: string, enabled: boolean, timeoutMs: number) {
  const executablePath = process.env.GOALS_CHROME_EXECUTABLE;
  if (kind === "chrome" && !executablePath) throw new Error("Set GOALS_CHROME_EXECUTABLE to genuine Google Chrome");
  const browser = kind === "chrome"
    ? await chromium.launch({ executablePath, headless: true, timeout: timeoutMs })
    : await firefox.launch({ headless: true, timeout: timeoutMs, env: { ...process.env, ...(enabled ? {
      MOZ_PROFILER_STARTUP: "1", MOZ_PROFILER_SHUTDOWN: join(output, "gecko.json"), MOZ_PROFILER_STARTUP_INTERVAL: String(geckoCollectorConfig.intervalMs),
      MOZ_PROFILER_STARTUP_ENTRIES: String(geckoCollectorConfig.entries), MOZ_PROFILER_STARTUP_FEATURES: geckoCollectorConfig.features,
      MOZ_PROFILER_STARTUP_FILTERS: geckoCollectorConfig.filters,
    } : {}) } });
  try { return await opened(browser, kind, output, enabled, timeoutMs); }
  catch (error) { await browser.close(); throw error; }
}

async function opened(browser: Browser, kind: ProfileBrowser, output: string, enabled: boolean, timeoutMs: number) {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const host = await context.newPage();
  const workers: { event: "born" | "exited"; url: string; at: number }[] = [];
  host.on("worker", worker => {
    workers.push({ event: "born", url: worker.url(), at: Date.now() });
    worker.on("close", () => workers.push({ event: "exited", url: worker.url(), at: Date.now() }));
  });
  const transport = createPageTransport(context, host, {
    browserName: kind, browserVersion: browser.version(),
    executable: kind === "chrome" ? process.env.GOALS_CHROME_EXECUTABLE : firefox.executablePath(), headless: true,
  }, timeoutMs, 3000, () => bounded(() => browser.close(), 15000));
  return { transport, workers,
    mark: async (label: string) => { if (enabled && kind === "chrome") await host.evaluate(message => { performance.mark(message); }, label); },
    capture: async () => enabled && kind === "chrome" ? trace(browser, output) : async () => {} };
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
      params: { expression: `performance.mark(${JSON.stringify("lifecycle-profile-target:" + targetId)})` } }) });
  }
  session.on("Target.targetDestroyed", ({ targetId }) => targets.push({ event: "exited", id: targetId, at: Date.now() }));
  await session.send("Target.setDiscoverTargets", { discover: true });
  const bufferUsage: { at: number; event: BufferUsage }[] = [];
  const telemetry: { requested: typeof chromeTraceConfig; startAccepted: boolean; bufferUsage: typeof bufferUsage;
    tracingComplete: TracingComplete | null; streamReadComplete: boolean } = {
    requested: chromeTraceConfig, startAccepted: false, bufferUsage, tracingComplete: null, streamReadComplete: false,
  };
  session.on("Tracing.bufferUsage", event => bufferUsage.push({ at: Date.now(), event }));
  const completed = new Promise<TracingComplete>(resolve => session.once("Tracing.tracingComplete", event => {
    telemetry.tracingComplete = event;
    resolve(event);
  }));
  void completed.catch(() => {});
  await session.send("Tracing.start", chromeTraceConfig);
  telemetry.startAccepted = true;
  return async () => {
    let handle: string | undefined;
    try {
      await session.send("Tracing.end");
      handle = (await bounded(() => completed, 60000)).stream;
      if (!handle) throw new Error("Trace stream unavailable");
      await readTrace(session, handle, join(output, "chrome-trace.json"));
      telemetry.streamReadComplete = true;
    } finally {
      await writeFile(join(output, "chrome-retention.json"), JSON.stringify(telemetry, null, 2));
      await writeFile(join(output, "chrome-targets.json"), JSON.stringify(targets));
      await writeFile(join(output, "chrome-annotation-errors.json"), JSON.stringify(annotationErrors));
      if (handle) await session.send("IO.close", { handle });
      await session.detach();
    }
  };
}

async function readTrace(session: CDPSession, handle: string, path: string) {
  const file = Bun.file(path).writer();
  let eof = false;
  try {
    while (!eof) {
      const part = await bounded(() => session.send("IO.read", { handle, size: 1 << 20 }), 15000);
      if (part.base64Encoded) throw new Error("Unexpected encoded trace stream");
      await file.write(part.data); await file.flush(); eof = part.eof ?? false;
    }
  } finally { await file.end(); }
}
