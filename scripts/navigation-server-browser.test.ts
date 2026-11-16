import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { webkit } from "playwright";
import { session } from "../web/tests/playground.mjs";
import { openPlaygroundPage } from "../web/tests/playground-navigation";
import { navigationParameter } from "../web/navigation-server-log";

async function boundary(mode: "before-arrival" | "in-handler" | "returned") {
  const task = session("bw-nav-control-");
  const previous = process.env.BUN_WASM_NAVIGATION_LOG;
  process.env.BUN_WASM_NAVIGATION_LOG = join(task.scratch, "requests.jsonl");
  const reports = join(task.scratch, "reports");
  const previousReports = process.env.BUN_WASM_BROWSER_REPORT_DIR;
  process.env.BUN_WASM_BROWSER_REPORT_DIR = reports;
  try {
    const root = join(task.scratch, "site");
    mkdirSync(root);
    writeFileSync(join(root, "index.html"), '<span id="status">ready</span>');
    const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, {
      ROOT: root, PORT: "0", LATENCY_MS: mode === "in-handler" ? "1500" : "0",
    });
    const url = match[1]!;
    const browser = await task.launch(webkit);
    const page = await browser.newPage();
    if (mode === "before-arrival") await page.route("**/*", route => route.abort());
    const goto = page.goto.bind(page);
    let attempts = 0;
    let originalTarget = "";
    page.goto = (target, options) => { attempts++; originalTarget = target; return goto(target, { ...options, timeout: 750 }); };
    let failure: unknown;
    try { await openPlaygroundPage(page, url, { readyTimeout: 100 }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(attempts).toBe(1);
    const names = readdirSync(reports);
    expect(names).toHaveLength(1);
    const report: unknown = JSON.parse(readFileSync(join(reports, names[0]!), "utf8"));
    expect(report).toMatchObject({
      url: originalTarget, error: String(failure), stage: mode === "returned" ? "runtime-publication" : "navigation",
      originalServerRequest: { outcome: "ok", value: {
        enabled: true, id: expect.any(String), listening: [expect.objectContaining({ event: "listening", url })],
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
    expect(await page.evaluate(() => location.href)).toBe(mode === "returned" ? page.url() : "about:blank");
  } finally {
    await task.cleanup();
    if (previous === undefined) delete process.env.BUN_WASM_NAVIGATION_LOG;
    else process.env.BUN_WASM_NAVIGATION_LOG = previous;
    if (previousReports === undefined) delete process.env.BUN_WASM_BROWSER_REPORT_DIR;
    else process.env.BUN_WASM_BROWSER_REPORT_DIR = previousReports;
  }
}

for (const mode of ["before-arrival", "in-handler", "returned"] as const) {
  test(`WebKit original navigation host boundary: ${mode}`, () => boundary(mode), 20_000);
}
