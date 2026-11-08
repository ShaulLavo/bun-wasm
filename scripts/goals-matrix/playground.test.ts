import { test, expect } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { command, start } from "./playground";
import { execute } from "./execute";
import { frameworks } from "./catalog";
import type { Transport } from "./transport";
function page(submit: (shell: { running: boolean; lastExit: number }, listen: () => void) => Promise<void>, listeningPort = 5173): Transport {
  const shell = { running: false, lastExit: 0, submit: async (_text: string) => submit(shell, () => { listening = true; }), input() {} };
  let listening = false;
  const context = createContext({ crypto, playground: { shell, previews: { serves: (port: number) => port === listeningPort && listening, url: () => "http://preview/" }, term: { write: (_text: string, callback: () => void) => callback(), buffer: { active: { length: 0 } } } } });
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


test("server readiness observes the task's configured free guest port", async () => {
  const transport = page(async (_shell, listen) => { listen(); await new Promise(() => {}); }, 41373);
  expect(await start(transport, "bun run dev --port 41373", 100, 41373)).toBe("http://preview/");
});
