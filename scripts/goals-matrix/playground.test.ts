import { test, expect } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { command, start } from "./playground";
import { execute } from "./execute";
import { frameworks } from "./catalog";
import type { Transport } from "./transport";
import { createSafariTransport } from "./safari-transport";
import { withPlayground } from "./test-fixture";
function page(submit: (shell: { running: boolean; lastExit: number }, listen: () => void) => Promise<void>, previewReady = Promise.resolve("ready")): Transport {
  const shell = { running: false, lastExit: 0, submit: async (_text: string) => submit(shell, () => { listening = true; }), input() {} };
  let listening = false;
  const context = createContext({ crypto, playground: { shell, previews: { serves: () => listening, url: () => "http://preview/", ready: previewReady }, term: { write: (_text: string, callback: () => void) => callback(), buffer: { active: { length: 0 } } } } });
  return { capabilities: { browserName: "unit-test" }, async navigate() {}, async openPreview() {}, async useHost() {}, async usePreview() {}, async closePreview() {}, async close() {},
    async evaluate<T>(expression: string): Promise<T> { return runInContext(expression, context); },
  };
}
test("a previous idle zero exit cannot mask a new asynchronous nonzero command", async () => {
  const transport = page(async shell => { await Bun.sleep(30); shell.running = true; await Bun.sleep(30); shell.lastExit = 17; shell.running = false; });
  await expect(command(transport, "fails later", 1000)).rejects.toThrow("exited 17");
});
test("a server start waits for its own asynchronous listener instead of previous idle state", async () => {
  let listened = false;
  const transport = page(async (_shell, listen) => { await Bun.sleep(50); listened = true; listen(); await new Promise(() => {}); });
  expect(await start(transport, "starts later", 1000)).toBe("http://preview/");
  expect(listened).toBe(true);
});
test("a failed asynchronous start preserves its actual failure", async () => {
  const transport = page(async shell => { await Bun.sleep(25); shell.lastExit = 9; });
  await expect(start(transport, "fails later", 1000)).rejects.toThrow("without listening");
});
test("startup timeout closes a transport whose factory resolves after the deadline", async () => {
  let closed = 0;
  let navigated = false;
  const transport = page(async () => {});
  transport.close = async () => { closed++; };
  transport.navigate = async () => { navigated = true; };
  const framework = frameworks[0]!;
  const result = await execute({ box: { framework: framework.id, browser: "chrome", engine: "browser" }, framework, url: "http://unit.test/", timeoutMs: 10,
    async createTransport() { await Bun.sleep(50); return transport; }, async saveLog() {},
  });
  expect(result.status).toBe("fail"); expect(closed).toBe(1); expect(navigated).toBe(false);
});

test("a server start waits for its preview worker to activate before returning its URL", async () => {
  const activation = Promise.withResolvers<string>();
  const transport = page(async (_shell, listen) => { listen(); await new Promise(() => {}); }, activation.promise);
  let returned = false;
  const started = start(transport, "starts before preview activation", 1000).then(url => { returned = true; return url; });
  try {
    await Bun.sleep(25);
    expect(returned).toBe(false);
  } finally { activation.resolve("ready"); }
  expect(await started).toBe("http://preview/");
});

test.each(["failed", "unsupported"])("a server start rejects a %s preview transport", async state => {
  const transport = page(async (_shell, listen) => { listen(); await new Promise(() => {}); }, Promise.resolve(state));
  await expect(start(transport, "starts without preview transport", 1000)).rejects.toThrow(`Preview transport is ${state}`);
});

test("a preview activation rejection keeps its original error", async () => {
  const error = new Error("preview registration rejected");
  const activation = Promise.reject(error);
  void activation.catch(() => {});
  const transport = page(async (_shell, listen) => { listen(); await new Promise(() => {}); }, activation);
  await expect(start(transport, "starts with rejected activation", 1000)).rejects.toBe(error);
});

function safariDriver(fixture: Transport, onPreview: () => void) {
  let deleted = false;
  async function evaluated(expression: string): Promise<Response> {
    if (expression.includes("function previewReady")) onPreview();
    const value = await fixture.evaluate(expression);
    return Response.json({ value: { ok: true, json: JSON.stringify(value ?? null) } });
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/session") return Response.json({ value: { sessionId: "preview-cancellation", capabilities: { browserName: "Safari", platformName: "macOS" } } });
    if (request.method === "DELETE" && path === "/session/preview-cancellation") { deleted = true; return Response.json({ value: null }); }
    if (path.endsWith("/window") && request.method === "GET") return Response.json({ value: "host" });
    if (!path.endsWith("/execute/async")) return Response.json({ value: null });
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("args" in body) || !Array.isArray(body.args) || typeof body.args[0] !== "string") throw new Error("Missing evaluation");
    return evaluated(body.args[0]);
  } });
  return { server, deleted: () => deleted };
}

test("pending preview activation leaves the serialized Safari transport free for cancellation cleanup", async () => {
  const framework = frameworks[0]!;
  await withPlayground(framework, 0, async fixture => {
    const controller = new AbortController();
    await fixture.evaluate("globalThis.activation = Promise.withResolvers(); playground.previews.ready = activation.promise; void 0");
    const driver = safariDriver(fixture, () => queueMicrotask(() => controller.abort()));
    const transport = await createSafariTransport({ endpoint: driver.server.url.href, browser: "safari", timeoutMs: 30_000 });
    try {
      const result = await execute({ framework, box: { framework: framework.id, browser: "safari", engine: "browser" },
        url: "http://fixture/?engine=browser", timeoutMs: 30_000, signal: controller.signal,
        async createTransport() { return transport; }, async saveLog() {},
      });
      expect(result).toMatchObject({ status: "fail", phase: "dev" });
      expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass" });
      expect(driver.deleted()).toBe(true);
    } finally {
      await fixture.evaluate("activation.resolve('ready')");
      await transport.close();
      await driver.server.stop(true);
    }
  });
}, 30_000);
