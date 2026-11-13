import { expect, test } from "bun:test";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { readFile } from "node:fs/promises";
import { openTemplate, ready, restart } from "../sandbox/tests/storage-browser";

// Exercise the source methods, with only the runtime and renderer replaced by a tiny page.
const source = await readFile(new URL("../sandbox/src/sandbox.ts", import.meta.url), "utf8");
function section(start: string, end: string): string {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
const fixture = new Bun.Transpiler({ loader: "ts" }).transformSync(`
class Fixture {
  frame = document.querySelector("iframe");
  server = null;
  preview = null;
  serverTiming = { started: 0, visibleStart: 0 };
  engine = "browser";
  wasm = { size: 1 };
  message = { text: "", kind: "" };
  previews = { ready: Promise.resolve("ready"), register() {}, unregister() {}, url: port => location.origin + "/__preview/" + port + "/" };
  report(error) { throw error; }
  setServerState(state) { document.querySelector("#server-dot").dataset.state = state; }
  setStatus(text, kind = "") { this.message = { text, kind }; const status = document.querySelector("#status"); status.textContent = text; status.dataset.kind = kind; }
  ${section("  private readonly network:", "  constructor(")}
  ${section("  private async showPreview(", "  private async save(")}
}
const measureStartup = () => {};
const ENGINES = { browser: { name: "Browser (native)" } };
const mb = () => "1 MB";
globalThis.control = new Fixture();
const addLoad = control.frame.addEventListener.bind(control.frame);
control.frame.addEventListener = (type, listener, options) => {
  if (type === "load") globalThis.loadPreview = listener;
  addLoad(type, listener, options);
};
globalThis.sameHelper = {};
globalThis.flushHook = null;
globalThis.flushes = 0;
globalThis.sandbox = {
  server: () => control.server, preview: () => control.preview, status: () => control.message,
  started: () => true, template: "vanilla",
  fs: { state: { status: "ready" }, flush: async () => { flushes++; if (flushHook) await flushHook(); } },
};
globalThis.listen = port => control.network.listening(port, sameHelper);
document.querySelector("#restart").onclick = () => { control.server = null; control.setServerState("starting"); queueMicrotask(() => listen(5174)); };
listen(5173);
`);
const html = `<span id="status"></span><span id="server-dot"></span><button id="restart">Restart</button><iframe id="preview"></iframe><script>${fixture}</script>`;

async function model(browser: Browser, run: (page: Page, control: { hold: boolean; requests: number; release(): void }) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  const held: (() => void)[] = [];
  const control = { hold: false, requests: 0, release() { control.hold = false; for (const resume of held.splice(0)) resume(); } };
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(2000);
    await page.route("http://readiness.test/**", async route => {
      if (!route.request().url().includes("/__preview/")) { await route.fulfill({ contentType: "text/html", body: html }); return; }
      control.requests++;
      if (control.hold) await new Promise<void>(resolve => { held.push(resolve); });
      await route.fulfill({ contentType: "text/html", body: '<h1>Edited source persists</h1><button class="counter">count is 0</button>' });
    });
    await run(page, control);
  } finally { control.release(); await context.close(); }
}

async function normalAndRepeated(browser: Browser): Promise<void> {
  await model(browser, async (page, control) => {
    await openTemplate(page, "http://readiness.test/sandbox/", "vanilla");
    expect(await page.evaluate(() => Reflect.get(globalThis, "flushes"))).toBe(1);
    expect(control.requests).toBe(1);
    let interleave = true;
    const wrapped = new Proxy(page, { get(target, property) {
      if (property !== "waitForFunction") return Reflect.get(target, property, target);
      return async (...args: Parameters<Page["waitForFunction"]>) => {
        const candidate = await target.waitForFunction(...args);
        if (interleave) { interleave = false; await target.evaluate(() => Reflect.get(globalThis, "listen")(5173)); }
        return candidate;
      };
    } });
    await ready(wrapped, "vanilla");
    expect(control.requests).toBe(2);
    expect(await page.locator("#status").getAttribute("data-kind")).toBe("ok");
    await restart(page);
    expect(await page.locator("#preview").getAttribute("src")).toContain("/5174/");
  });
}

type Landing = "redirect" | "query" | "other-server" | "outside-preview";

function previewResponse(request: Request, landing: Landing): Response {
  const url = new URL(request.url);
  const headers = { "content-type": "text/html; charset=utf-8" };
  if (url.pathname === "/sandbox/") return new Response(html, { headers });
  if (url.pathname === "/__preview/5174/" && landing !== "query") {
    const path = landing === "redirect" ? "/__preview/5174/route?redirected=1" : landing === "other-server" ? "/__preview/5175/" : "/__preview/5174-other/";
    return Response.redirect(new URL(path, url), 302);
  }
  const script = landing === "query" && url.pathname === "/__preview/5174/" ? '<script>history.replaceState(null,"","?app=1")</script>' : "";
  return new Response(`<button class="counter">live app</button>${script}`, { headers });
}

async function redirectedNavigation(browser: Browser, landing: Landing): Promise<void> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => previewResponse(request, landing) });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await openTemplate(page, new URL("sandbox/", server.url).href, "vanilla");
    await page.evaluate(() => Reflect.get(globalThis, "listen")(5174));
    await page.frameLocator("#preview").locator("button.counter").waitFor();
    if (landing === "other-server" || landing === "outside-preview") {
      await expect(ready(page, "vanilla", Date.now() + 200)).rejects.toThrow(/deadline|Timeout/);
      expect(await page.locator("#status").getAttribute("data-kind")).toBe("");
      return;
    }
    await ready(page, "vanilla", Date.now() + 1500);
    expect(await page.locator("#status").getAttribute("data-kind")).toBe("ok");
    expect(await page.evaluate(() => Reflect.get(globalThis, "flushes"))).toBe(2);
    expect(await page.locator("#preview").getAttribute("src")).toEndWith("/__preview/5174/");
  } finally { await context.close(); await server.stop(true); }
}

async function redirectsAndQueries(browser: Browser): Promise<void> {
  for (const landing of ["redirect", "query", "other-server", "outside-preview"] as const) await redirectedNavigation(browser, landing);
}

async function invalidLoads(browser: Browser): Promise<void> {
  await model(browser, async (page, control) => {
    await openTemplate(page, "http://readiness.test/sandbox/", "vanilla");
    control.hold = true;
    await Promise.all([page.waitForRequest("**/__preview/**"), page.evaluate(() => Reflect.get(globalThis, "listen")(5173))]);
    // Model a trusted notification for the still-current old document at the same URL.
    await page.evaluate(() => Reflect.get(globalThis, "loadPreview")({ isTrusted: true }));
    expect(await page.locator("#status").getAttribute("data-kind")).toBe("");
    await page.evaluate(() => document.querySelector("iframe")!.dispatchEvent(new Event("load")));
    expect(await page.locator("#status").getAttribute("data-kind")).toBe("");
    expect(await page.evaluate(() => Reflect.get(globalThis, "control").preview?.loaded)).toBeNull();
    await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
      const loaded = new Promise<void>(resolve => frame.addEventListener("load", () => resolve(), { once: true }));
      frame.srcdoc = "<h1>Unrelated document</h1>";
      await loaded;
    });
    expect(await page.locator("#status").getAttribute("data-kind")).toBe("");
    control.release();
    await page.locator("#preview").evaluate(frame => frame.removeAttribute("srcdoc"));
    await ready(page, "vanilla");
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "preview";
      document.querySelector("iframe")!.replaceWith(frame);
      Reflect.get(globalThis, "control").frame = frame;
    });
    await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>("#preview")?.contentDocument?.readyState === "complete");
    await expect(ready(page, "vanilla", Date.now() + 150)).rejects.toThrow(/deadline|Timeout/);
    await page.evaluate(() => Reflect.get(globalThis, "listen")(5174));
    await ready(page, "vanilla");
    expect(await page.locator("#preview").getAttribute("src")).toContain("/5174/");
  });
}

async function changesDuringFlush(browser: Browser): Promise<void> {
  await model(browser, async page => {
    await openTemplate(page, "http://readiness.test/sandbox/", "vanilla");
    await page.evaluate(() => Reflect.set(globalThis, "flushHook", async () => {
      Reflect.set(globalThis, "flushHook", null);
      Reflect.get(globalThis, "listen")(5174);
    }));
    await ready(page, "vanilla");
    expect(await page.evaluate(() => Reflect.get(globalThis, "flushes"))).toBe(3);
    expect(await page.locator("#preview").getAttribute("src")).toContain("/5174/");
    await page.evaluate(() => Reflect.set(globalThis, "flushHook", async () => {
      location.assign("/sandbox/?parent=replaced");
      await new Promise(() => {});
    }));
    await ready(page, "vanilla");
    expect(page.url()).toContain("parent=replaced");
    expect(await page.evaluate(() => Reflect.get(globalThis, "flushes"))).toBe(1);
  });
}

function installFailure(failure: string): void {
  const control = Reflect.get(globalThis, "control");
  const report = () => {
    control.setStatus("real startup error", "error");
    if (failure.startsWith("transient")) control.setStatus("loading preview", "");
  };
  if (failure.endsWith("during flush")) { Reflect.set(globalThis, "flushHook", report); return; }
  if (failure === "flush") { Reflect.set(globalThis, "flushHook", () => Promise.reject(new Error("flush refused"))); return; }
  if (failure === "filesystem") { Reflect.get(globalThis, "sandbox").fs.state = { status: "failed", error: new Error("filesystem refused") }; return; }
  report();
}

async function failures(browser: Browser): Promise<void> {
  for (const failure of ["startup", "transient", "filesystem", "flush", "error during flush", "transient during flush"]) await model(browser, async page => {
    await openTemplate(page, "http://readiness.test/sandbox/", "vanilla");
    await page.evaluate(installFailure, failure);
    await expect(ready(page, "vanilla")).rejects.toThrow(/error|refused/);
  });
}

function invalidateEachCheckpoint(): void {
  const control = Reflect.get(globalThis, "control");
  Reflect.set(globalThis, "flushHook", () => { control.preview = { ...control.preview }; });
}

async function deadlines(browser: Browser): Promise<void> {
  await model(browser, async page => {
    await openTemplate(page, "http://readiness.test/sandbox/", "vanilla");
    await page.evaluate(invalidateEachCheckpoint);
    const started = Date.now();
    await expect(ready(page, "vanilla", started + 1000)).rejects.toThrow(/deadline|Timeout/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await page.evaluate(() => Reflect.get(globalThis, "flushes"))).toBeGreaterThan(1);
  });
  await model(browser, async page => {
    await openTemplate(page, "http://readiness.test/sandbox/", "vanilla");
    await page.evaluate(() => Reflect.set(globalThis, "flushHook", () => new Promise(() => {})));
    await expect(ready(page, "vanilla", Date.now() + 150)).rejects.toThrow(/deadline|Timeout/);
  });
}

const cases = [normalAndRepeated, redirectsAndQueries, invalidLoads, changesDuringFlush, failures, deadlines];
for (const engine of [chromium, webkit]) for (const run of cases) test(`${engine.name()}: ${run.name}`, async () => {
  const browser = await engine.launch({ headless: true });
  try { await run(browser); } finally { await browser.close(); }
}, 15_000);
