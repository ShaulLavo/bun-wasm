import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webkit, type Page } from "playwright";
import { session } from "../web/tests/playground.mjs";
import { openPlaygroundPage } from "../web/tests/playground-navigation";
import { navigationParameter, navigationServerListening, navigationServerLog, readNavigationServerLog } from "../web/navigation-server-log";

type Boundary = "before-arrival" | "in-handler" | "returned";
const html = '<span id="status">ready</span>';

function heldHost(mode: Boundary) {
  const arrival = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const record = navigationServerLog(request);
    if (mode === "in-handler" && new URL(request.url).searchParams.has(navigationParameter)) {
      arrival.resolve();
      await release.promise;
    }
    const response = new Response(html, { headers: { "content-type": "text/html" } });
    record("response-return", { status: response.status });
    return response;
  } });
  navigationServerListening(server.url);
  return { server, arrival, release };
}

async function boundary(mode: Boundary) {
  const task = session("bw-nav-control-");
  const previous = process.env.BUN_WASM_NAVIGATION_LOG;
  process.env.BUN_WASM_NAVIGATION_LOG = join(task.scratch, "requests.jsonl");
  const reports = join(task.scratch, "reports");
  const previousReports = process.env.BUN_WASM_BROWSER_REPORT_DIR;
  process.env.BUN_WASM_BROWSER_REPORT_DIR = reports;
  const host = heldHost(mode);
  let pending: ReturnType<Page["goto"]> | undefined;
  try {
    const browser = await task.launch(webkit);
    const page = await browser.newPage();
    if (mode === "before-arrival") await page.route("**/*", route => route.abort());
    const goto = page.goto.bind(page);
    let attempts = 0;
    let originalTarget = "";
    const held = new Error("Original handler reached; response deliberately held");
    page.goto = async (target, options) => {
      attempts++;
      originalTarget = target;
      if (mode !== "in-handler") return goto(target, options);
      pending = goto(target, options);
      void pending.catch(() => undefined);
      await Promise.race([host.arrival.promise, pending]);
      throw held;
    };
    let failure: unknown;
    try { await openPlaygroundPage(page, String(host.server.url)); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (mode === "in-handler") expect(failure).toBe(held);
    expect(attempts).toBe(1);
    const names = readdirSync(reports);
    expect(names).toHaveLength(1);
    const report: unknown = JSON.parse(readFileSync(join(reports, names[0]!), "utf8"));
    expect(report).toMatchObject({
      url: originalTarget, error: String(failure), stage: mode === "returned" ? "runtime-publication" : "navigation",
      pageAtFailure: { url: mode === "returned" ? originalTarget : "about:blank", closed: false, browserConnected: true },
      requests: { lifecycle: { documentCommitted: mode === "returned", domcontentloaded: mode === "returned" } },
      originalServerRequest: { outcome: "ok", value: {
        enabled: true, availability: "observed", id: expect.any(String),
        listening: [expect.objectContaining({ event: "listening", url: String(host.server.url) })],
        events: mode === "returned"
          ? [expect.objectContaining({ event: "arrival" }), expect.objectContaining({ event: "response-return", detail: { status: 200 } })]
          : mode === "in-handler" ? [expect.objectContaining({ event: "arrival" })] : [],
      } },
      server: { outcome: "ok", value: { status: 200 } },
    });
    const entries: unknown[] = readFileSync(process.env.BUN_WASM_NAVIGATION_LOG!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const id = new URL(originalTarget).searchParams.get(navigationParameter);
    expect(id).toBeTruthy();
    expect(entries.filter(entry => entry !== null && typeof entry === "object" && "event" in entry && entry.event === "arrival"))
      .toHaveLength(mode === "before-arrival" ? 0 : 1);
    for (const entry of entries) {
      expect(entry !== null && typeof entry === "object" && "id" in entry && (entry.id === null || entry.id === id)).toBe(true);
    }
  } finally {
    host.release.resolve();
    await task.cleanup();
    await pending?.catch(() => undefined);
    await host.server.stop(true);
    if (previous === undefined) delete process.env.BUN_WASM_NAVIGATION_LOG;
    else process.env.BUN_WASM_NAVIGATION_LOG = previous;
    if (previousReports === undefined) delete process.env.BUN_WASM_BROWSER_REPORT_DIR;
    else process.env.BUN_WASM_BROWSER_REPORT_DIR = previousReports;
  }
}

for (const mode of ["before-arrival", "in-handler", "returned"] as const) {
  test("WebKit original navigation host boundary: " + mode, () => boundary(mode), 60_000);
}

test("missing, empty and ambiguous journals cannot qualify original-request absence", async () => {
  const task = session("bw-nav-log-");
  const previous = process.env.BUN_WASM_NAVIGATION_LOG;
  const path = join(task.scratch, "requests.jsonl");
  process.env.BUN_WASM_NAVIGATION_LOG = path;
  try {
    await expect(readNavigationServerLog("original", "http://127.0.0.1:1234/")).rejects.toThrow("ENOENT");
    for (const records of [[], [{ id: null, event: "listening", url: "http://127.0.0.1:4321/" }],
      Array.from({ length: 2 }, () => ({ id: null, event: "listening", url: "http://127.0.0.1:1234/" }))]) {
      writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n"));
      expect(await readNavigationServerLog("original", "http://127.0.0.1:1234/")).toMatchObject({ availability: "unknown", events: [] });
    }
  } finally {
    await task.cleanup();
    if (previous === undefined) delete process.env.BUN_WASM_NAVIGATION_LOG;
    else process.env.BUN_WASM_NAVIGATION_LOG = previous;
  }
});

test("the original static host publishes its qualified request journal", async () => {
  const task = session("bw-nav-host-");
  const previous = process.env.BUN_WASM_NAVIGATION_LOG;
  process.env.BUN_WASM_NAVIGATION_LOG = join(task.scratch, "requests.jsonl");
  try {
    const root = join(task.scratch, "site");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), html);
    const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: root, PORT: "0" });
    const target = new URL(match[1]!);
    target.searchParams.set(navigationParameter, "original");
    expect((await fetch(target)).status).toBe(200);
    expect(await readNavigationServerLog("original", target.href)).toMatchObject({ availability: "observed", events: [
      expect.objectContaining({ event: "arrival", id: "original" }),
      expect.objectContaining({ event: "response-return", id: "original", detail: { status: 200 } }),
    ] });
  } finally {
    await task.cleanup();
    if (previous === undefined) delete process.env.BUN_WASM_NAVIGATION_LOG;
    else process.env.BUN_WASM_NAVIGATION_LOG = previous;
  }
});
