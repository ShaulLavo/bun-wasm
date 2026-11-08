import { test, expect } from "bun:test";
import { chromium, type Page } from "playwright";
import { frameworks } from "./catalog";
import { edit, render } from "./playground";
import { evaluatePage, type Transport } from "./transport";

const framework = frameworks.find(framework => framework.id === "astro")!;
const timeoutMs = 2_000;

function hostDocument(): string {
  return `<!doctype html><script>
    let source = ${JSON.stringify(framework.text)};
    globalThis.playground = { editor: {
      async open() {},
      async save() { await fetch('/save', { method: 'POST', body: source }); },
      view: { state: { doc: { toString: () => source } },
        dispatch(change) { source = change.changes.insert; } }
    } };
  </script>`;
}

function previewDocument(message: string): string {
  return `<!doctype html><h1 id="message">${message}</h1><output id="count">1</output>
    <script>${message === framework.text ? "fetch('/reload').then(() => location.reload())" : ""}</script>`;
}

async function withPreview(action: (transport: Transport, state: { navigations: number; observations: number; saves: number }) => Promise<void>): Promise<void> {
  let message = framework.text;
  const reload = Promise.withResolvers<void>();
  const state = { navigations: 0, observations: 0, saves: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/save") { state.saves++; message = await request.text(); return new Response("saved"); }
    if (path === "/reload") { await reload.promise; return new Response("reload"); }
    if (path === "/observing") { state.observations++; reload.resolve(); return new Response("observing"); }
    if (path === "/preview") state.navigations++;
    return new Response(path === "/host" ? hostDocument() : previewDocument(message), { headers: { "content-type": "text/html" } });
  } });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath: process.env.GOALS_CHROME_EXECUTABLE, headless: true });
    const context = await browser.newContext();
    const host = await context.newPage(), preview = await context.newPage();
    await host.goto(new URL("host", server.url).href);
    await preview.goto(new URL("preview", server.url).href, { waitUntil: "domcontentloaded" });
    let page: Page = preview;
    const transport: Transport = {
      capabilities: { browserName: "chromium", browserVersion: browser.version() },
      async navigate() { throw new Error("No test navigation is allowed"); },
      async openPreview() { throw new Error("The preview is already open"); },
      async useHost() { page = host; }, async usePreview() { page = preview; },
      async closePreview() {}, async close() {},
      evaluate<T>(expression: string, options?: Parameters<Transport["evaluate"]>[1]): Promise<T> {
        const observed = page === preview && message !== framework.text && expression.includes("function rendered(")
          ? `(async () => { if (document.querySelector('#message').textContent === ${JSON.stringify(framework.text)}) { await fetch('/observing'); await new Promise(() => {}); } return (${expression}); })()`
          : expression;
        return evaluatePage<T>(page, observed, timeoutMs, options);
      },
    };
    await action(transport, state);
  } finally {
    reload.resolve();
    await browser?.close();
    await server.stop(true);
  }
}

test("Astro hot reload survives a document replacement during its DOM observation", async () => {
  await withPreview(async (transport, state) => {
    const evidence = await edit(transport, framework, timeoutMs);
    expect(evidence).toMatchObject({ before: "1", sameDocument: false, manualNavigations: 0,
      result: { text: `${framework.text} hot updated`, matched: true } });
    expect(state).toEqual({ navigations: 2, observations: 1, saves: 1 });
  });
}, 10_000);

test("an unchanged preview still fails its original render bound", async () => {
  await withPreview(async transport => {
    await expect(render(transport, { ...framework, selector: "#absent" }, "missing update", 100)).rejects.toThrow("Timed out after 100 ms");
  });
}, 10_000);

test("a one-shot action is not replayed when navigation destroys its result", async () => {
  await withPreview(async (transport, state) => {
    await expect(transport.evaluate("(async () => { await fetch('/observing'); return new Promise(() => {}); })()")).rejects.toThrow("Execution context was destroyed");
    expect(state).toEqual({ navigations: 2, observations: 1, saves: 0 });
  });
}, 10_000);

test("DOM observation errors and one-shot command errors remain failures", async () => {
  const browser = await chromium.launch({ executablePath: process.env.GOALS_CHROME_EXECUTABLE, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("data:text/html,<h1>control</h1>");
    await expect(evaluatePage(page, "(() => { throw new Error('render broke'); })()", timeoutMs, { observation: true })).rejects.toThrow("render broke");
    await expect(evaluatePage(page, "(() => { globalThis.actions = (globalThis.actions ?? 0) + 1; throw new Error('command broke'); })()", timeoutMs)).rejects.toThrow("command broke");
    expect(await page.evaluate("globalThis.actions")).toBe(1);
    await page.close();
    await expect(evaluatePage(page, "document.title", timeoutMs, { observation: true })).rejects.toThrow(/closed/);
  } finally { await browser.close(); }
}, 10_000);
