import { mock } from "bun:test";
import assert from "node:assert/strict";
import * as filesystem from "node:fs/promises";
import { chromium, errors } from "playwright";

const original = { ...filesystem };
const directory = process.env.BUN_WASM_BROWSER_REPORT_DIR;
assert.ok(directory);
let writes = 0;
mock.module("node:fs/promises", () => ({
  ...original,
  writeFile: async (...args: Parameters<typeof original.writeFile>) => {
    if (!String(args[0]).startsWith(directory)) return original.writeFile(...args);
    writes++;
    console.log("STALLED_REPORT_WRITE");
    await new Promise<never>(() => {});
  },
}));

const { openQuickjsStackPage } = await import("../../web/tests/quickjs-stack-navigation");
const { openPlaygroundPage } = await import("../../web/tests/playground-navigation");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe body") });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let closing: Promise<unknown> | undefined;
const cleanup = () => closing ??= Promise.all([browser?.close(), server.stop(true)]);
const timer = setTimeout(() => { void cleanup().finally(() => process.exit(124)); }, 45_000);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const count = Reflect.get(page, "listenerCount");
  assert.equal(typeof count, "function");
  const events = ["request", "response", "requestfinished", "requestfailed", "framenavigated", "domcontentloaded", "load", "crash", "pageerror"];
  const counts = () => events.map(event => Reflect.apply(count, page, [event]));
  const before = counts();
  const failure = new errors.TimeoutError("fixture navigation timeout");
  page.goto = async () => { throw failure; };
  const open = () => process.env.NAVIGATION_CONSUMER === "browser"
    ? openPlaygroundPage(page, `${server.url}?engine=browser&prompt=off`)
    : openQuickjsStackPage(page, String(server.url));
  await assert.rejects(open, error => error === failure);
  assert.equal(writes, 1);
  assert.deepEqual(counts(), before);
  console.log("STALLED_REPORT_RESULT original error preserved; listeners removed");
} finally {
  clearTimeout(timer);
  await cleanup();
}
