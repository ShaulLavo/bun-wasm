import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";
import { mkdtemp, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, options } from "./goals-matrix/run";
import { renderedReact, sampleDeadline } from "./measure-react-startup";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/broken") return new Response("broken startup", { status: 500 });
    if (url.pathname === "/hung") return new Response("<body>hung page<script>while (true) {}</script>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/frame") return new Response(`<div id="root"><h1>Hello from bun.wasm</h1><button ${url.searchParams.has("inert") ? "" : `onclick="this.textContent='count is 1'"`}>count is 0</button></div>`, { headers: { "content-type": "text/html" } });
    return new Response(`<span id="server-dot" data-state="up"></span><iframe id="preview" src="/frame${url.search}"></iframe>`, { headers: { "content-type": "text/html" } });
  } });
  browser = await chromium.launch();
});
afterAll(async () => { try { await browser?.close(); } finally { server?.stop(true); } });

test("React timing ends only after the visible frame paints and the counter works", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    const result = await renderedReact(page);
    expect(result.renderMs).toBeGreaterThan(0);
    expect(result.interactiveMs).toBeGreaterThanOrEqual(result.renderMs);
  } finally { await page.close(); }
});

test("a listening server and static heading cannot pass a broken counter", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?inert`);
    await page.frameLocator("#preview").locator("h1").waitFor({ timeout: 5000 });
    page.setDefaultTimeout(250);
    await expect(renderedReact(page)).rejects.toThrow("Timeout");
  } finally { await page.close(); }
});

test("an iframe load without a React heading cannot pass startup", async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(250);
  try {
    await page.goto(server.url.href);
    await page.frameLocator("#preview").locator("h1").evaluate(node => node.remove());
    await expect(renderedReact(page)).rejects.toThrow("Hello from bun.wasm");
  } finally { await page.close(); }
});

test("maintained goals invocation rejects an HTTP failure and reaps its startup browser", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-react-gate-"));
  const root = join(scratch, "site"), output = join(scratch, "report");
  try {
    await mkdir(root);
    await expect(run(options([`--root=${root}`, `--output=${output}`, "--asset-source=control-no-assets",
      `--react-startup-url=${new URL("/broken", server.url)}`]))).rejects.toThrow("exited 1");
    const result = await Bun.file(join(output, "react-startup.json")).json();
    expect(result.errors.join("\n")).toContain("React navigation HTTP 500");
    expect(result.cleanup.browserClosed).toBe(true);
    expect(result.samples).toEqual([]);
    await expect(access(join(output, ".goals-matrix-lock"))).rejects.toThrow();
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 10_000);

test("a hung page cannot extend the sample deadline through failure diagnostics", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-react-hung-"));
  const output = join(scratch, "result.json");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    child = Bun.spawn([process.execPath, "scripts/measure-react-startup.ts", "--url", new URL("/hung", server.url).href,
      "--samples", "1", "--deadline-ms", "250", "--output", output], { stdout: "ignore", stderr: "ignore" });
    expect(await sampleDeadline(child.exited, 5000)).toBe(1);
    const result = await Bun.file(output).json();
    expect(result.errors.join("\n")).toMatch(/sample exceeded 250 ms|Timeout 250ms exceeded/);
    expect(result.errors.join("\n")).not.toContain("total deadline exceeded");
    expect(result.cleanup.browserClosed).toBe(true);
    expect(result.samples).toEqual([]);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    await child?.exited;
    await rm(scratch, { recursive: true, force: true });
  }
}, 10_000);
