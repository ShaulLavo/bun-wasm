import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAcceptancePhase } from "./app-matrix/next-acceptance-phase";
import { chromium, type Page } from "playwright";
import { runRouteCase } from "./app-matrix/next-acceptance-cases";

type Mode = "ok" | "http500" | "no-eof" | "fetch-stall" | "body-stall";
interface Resources {
  mode: Mode;
  active: Set<Request>;
  timers: Set<ReturnType<typeof setTimeout>>;
  aborts: number;
  cancellations: number;
}

function stream(request: Request, resources: Resources): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(resources.mode === "body-stall" ? '{"body":' : "NEXT-01 early\n"));
      if (resources.mode === "body-stall") return;
      timer = setTimeout(() => finishStream(request, resources, controller), 250);
      resources.timers.add(timer);
    },
    cancel() {
      clearTimeout(timer);
      if (timer) resources.timers.delete(timer);
      resources.active.delete(request);
      resources.cancellations++;
    },
  });
  return new Response(body, { status: resources.mode === "http500" ? 500 : request.method === "POST" ? 201 : 200, headers: { "content-type": "text/plain" } });
}

function finishStream(request: Request, resources: Resources, controller: ReadableStreamDefaultController<Uint8Array>) {
  controller.enqueue(new TextEncoder().encode("NEXT-01 late\n"));
  if (resources.mode === "no-eof") return;
  controller.close();
  resources.active.delete(request);
}

function pending(request: Request, resources: Resources): Promise<Response> {
  return new Promise(resolve => {
    request.signal.addEventListener("abort", () => {
      resources.aborts++;
      resources.active.delete(request);
      resolve(new Response(null, { status: 499 }));
    }, { once: true });
  });
}

function serve(request: Request, resources: Resources): Response | Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/")) return new Response("<!doctype html><title>probe</title>", { headers: { "content-type": "text/html" } });
  resources.active.add(request);
  if (resources.mode === "fetch-stall") return pending(request, resources);
  if (path === "/api/stream" || (resources.mode === "body-stall" && request.method === "POST")) return stream(request, resources);
  resources.active.delete(request);
  return Response.json({ pid: 123, body: { value: "NEXT-01 posted" } }, { status: request.method === "POST" ? 201 : 200 });
}

async function fixture(mode: Mode, operation: (page: Page, base: string, resources: Resources) => Promise<void>) {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-nh-"));
  const resources: Resources = { mode, active: new Set(), timers: new Set(), aborts: 0, cancellations: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => serve(request, resources) });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ env: { ...process.env, TMPDIR: scratch } });
    const page = await browser.newPage();
    page.setDefaultTimeout(200);
    page.setDefaultNavigationTimeout(1000);
    await operation(page, `http://127.0.0.1:${server.port}/`, resources);
  } finally {
    await browser?.close();
    for (const timer of resources.timers) clearTimeout(timer);
    await server.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function guarded<Value>(operation: Promise<Value>): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Test safety guard expired")), 1600); })]);
  } finally { clearTimeout(timer); }
}

async function rejected(operation: Promise<unknown>): Promise<string> {
  try { await guarded(operation); return "unexpected success"; }
  catch (error) { return String(error); }
}

async function released(resources: Resources) {
  const deadline = Date.now() + 500;
  while (resources.active.size && Date.now() < deadline) await Bun.sleep(10);
  expect(resources.active.size).toBe(0);
}

function probe(page: Page, base: string, name: "stream-cancel" | "get-post", timeout: number): Promise<unknown> {
  return runRouteCase(name, page, base, timeout);
}

test("stream probe rejects HTTP 500 and cancels its body", async () => {
  await fixture("http500", async (page, base, resources) => {
    const error = await rejected(probe(page, base, "stream-cancel", 900));
    expect(error).toMatch(/HTTP 500|status.*500/i);
    await released(resources);
    expect(resources.cancellations).toBeGreaterThan(0);
  });
}, 20000);

test("stream probe requires EOF and aborts an unfinished body", async () => {
  await fixture("no-eof", async (page, base, resources) => {
    const error = await rejected(probe(page, base, "stream-cancel", 700));
    expect(error).toMatch(/deadline|timeout|abort/i);
    await released(resources);
    expect(resources.cancellations).toBeGreaterThan(0);
  });
}, 20000);

test("evaluated fetch has a deadline that aborts the actual request", async () => {
  await fixture("fetch-stall", async (page, base, resources) => {
    const error = await rejected(probe(page, base, "get-post", 200));
    expect(error).toMatch(/deadline|timeout|abort/i);
    await released(resources);
    expect(resources.aborts).toBeGreaterThan(0);
  });
}, 20000);

test("evaluated JSON reader has a deadline that cancels its body", async () => {
  await fixture("body-stall", async (page, base, resources) => {
    const error = await rejected(probe(page, base, "get-post", 200));
    expect(error).toMatch(/deadline|timeout|abort/i);
    await released(resources);
    expect(resources.cancellations).toBeGreaterThan(0);
  });
}, 20000);

test("completed stream and intentional cancellation still pass", async () => {
  await fixture("ok", async (page, base, resources) => {
    await probe(page, base, "stream-cancel", 1200);
    await released(resources);
  });
}, 20000);


for (const mode of ["fetch-stall", "body-stall"] as const) {
  test(`${mode} persists a failed phase and reaches teardown`, async () => {
    await persistedFailure(mode, true);
  }, 20000);
}

test("phase deadline closes the context and aborts an uncooperative evaluated fetch", async () => {
  await persistedFailure("fetch-stall", false);
}, 20000);

async function persistedFailure(mode: Mode, cooperative: boolean) {
  const output = mkdtempSync(join(tmpdir(), "bun-wasm-nr-"));
  const report = join(output, "run.json");
  try {
    await fixture(mode, async (page, base, resources) => {
      await page.goto(base);
      const result = await guarded(runAcceptancePhase({ phase: "dev:get-post", engine: "browser", observedEngine: "Chromium control",
        timeoutMs: cooperative ? 1000 : 200, operation: () => phaseRequest(page, base, cooperative), cancel: () => page.context().close(),
        record: row => writeFileSync(report, JSON.stringify({ row, cleanup: "pending" })),
      }));
      expect(result.status).toBe("fail");
      if (result.status === "fail") expect(result.reason).toMatch(/deadline|timeout|abort/i);
      await released(resources);
      expect(resources.aborts + resources.cancellations).toBeGreaterThan(0);
      if (!cooperative) expect(page.isClosed()).toBe(true);
    });
    const saved = JSON.parse(readFileSync(report, "utf8"));
    writeFileSync(report, JSON.stringify({ ...saved, cleanup: "pass" }));
    expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({ row: { phase: "dev:get-post", status: "fail" }, cleanup: "pass" });
  } finally { rmSync(output, { recursive: true, force: true }); }
}

async function phaseRequest(page: Page, base: string, cooperative: boolean): Promise<void> {
  if (cooperative) { await runRouteCase("get-post", page, base, 200); return; }
  await page.evaluate(async base => {
    const response = await fetch(new URL("api/context", base));
    await response.text();
  }, base);
}
