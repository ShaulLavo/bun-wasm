import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { templateFiles } from "../src/template";

/** Diagnostic-only config injection. Normal template sources and runs stay unchanged. */
export async function instrumentNextCompilers(context: BrowserContext, template: string): Promise<void> {
  const config = readFileSync(new URL("./fixtures/next-profile-config.txt", import.meta.url), "utf8");
  await context.route(`**/template-${template}.json`, async route => {
    const response = await route.fetch();
    const files = templateFiles(await response.text());
    if (!files) throw new Error("Cannot profile an invalid template");
    files["next.config.ts"] = config;
    await route.fulfill({ response, json: { files } });
  });
}

/** Sample every worker because the Browser guest evaluates framework code in a worker. */
export async function profileNextWorkers(browser: Browser, reports: string): Promise<() => Promise<void>> {
  const cdp = await browser.newBrowserCDPSession();
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  cdp.on("Target.receivedMessageFromTarget", ({ message }) => {
    const value: unknown = JSON.parse(message);
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "number") return;
    const waiter = pending.get(value.id);
    if (!waiter) return;
    pending.delete(value.id);
    if ("error" in value) waiter.reject(new Error(JSON.stringify(value.error)));
    else waiter.resolve("result" in value ? value.result : undefined);
  });
  async function send(sessionId: string, method: string): Promise<unknown> {
    const current = ++id;
    const result = new Promise((resolve, reject) => pending.set(current, { resolve, reject }));
    await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: current, method }) });
    return result;
  }
  const { targetInfos } = await cdp.send("Target.getTargets");
  const workers = targetInfos.filter(target => target.type === "worker");
  const sessions: { sessionId: string; url: string }[] = [];
  for (const worker of workers) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: false });
    await send(sessionId, "Profiler.enable");
    await send(sessionId, "Profiler.start");
    sessions.push({ sessionId, url: worker.url });
  }
  console.log(`Profiling ${sessions.length} workers`);
  return async () => {
    for (const [index, worker] of sessions.entries()) {
      const result = await send(worker.sessionId, "Profiler.stop");
      writeFileSync(join(reports, `worker-${index}.cpuprofile.json`), JSON.stringify({ url: worker.url, result }));
    }
    await cdp.detach();
  };
}
