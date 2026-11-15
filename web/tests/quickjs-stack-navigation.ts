import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Request, Response } from "playwright";
import { ready } from "./playground.mjs";

async function observe<T>(read: () => Promise<T>, hangCap = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`diagnostic observation exceeded its ${hangCap} ms hang cap`)), hangCap); });
  try { return { outcome: "ok", value: await Promise.race([read(), expired]) } as const; }
  catch (error) { return { outcome: "error", error: String(error) } as const; }
  finally { clearTimeout(timer); }
}

function navigationRequests(page: Page) {
  const started = performance.now();
  const pending = new Set<Request>();
  const events: { event: string; url: string; elapsedMs: number; detail: string | number | null }[] = [];
  let requested = 0;
  function record(event: string, url: string, detail: string | number | null = null) {
    if (events.length === 250) events.shift();
    events.push({ event, url, elapsedMs: performance.now() - started, detail });
  }
  const request = (request: Request) => { requested++; pending.add(request); record("request", request.url(), request.resourceType()); };
  const response = (response: Response) => { record("response", response.url(), response.status()); };
  const finished = (request: Request) => { pending.delete(request); record("requestfinished", request.url()); };
  const failed = (request: Request) => { pending.delete(request); record("requestfailed", request.url(), request.failure()?.errorText ?? null); };
  const domcontentloaded = () => { record("domcontentloaded", page.url()); };
  const load = () => { record("load", page.url()); };
  const crash = () => { record("crash", page.url()); };
  const pageerror = (error: Error) => { record("pageerror", page.url(), error.message); };
  page.on("request", request).on("response", response).on("requestfinished", finished).on("requestfailed", failed);
  page.on("domcontentloaded", domcontentloaded).on("load", load);
  page.on("crash", crash).on("pageerror", pageerror);
  return {
    snapshot: () => ({ requested, elapsedMs: performance.now() - started, pending: Array.from(pending, request => request.url()), events: events.slice() }),
    stop() {
      page.off("request", request).off("response", response).off("requestfinished", finished).off("requestfailed", failed);
      page.off("domcontentloaded", domcontentloaded).off("load", load);
      page.off("crash", crash).off("pageerror", pageerror);
    },
  };
}

async function probeServer(url: string) {
  const started = performance.now();
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  const body = await response.arrayBuffer();
  return { status: response.status, bytes: body.byteLength, elapsedMs: performance.now() - started };
}

async function reportFailure(page: Page, url: string, error: unknown, requests: ReturnType<ReturnType<typeof navigationRequests>["snapshot"]>) {
  const browser = page.context().browser()?.browserType().name() ?? "disconnected";
  const pageAtFailure = { url: page.url(), closed: page.isClosed(), browserConnected: page.context().browser()?.isConnected() ?? false };
  const [pageState, server] = await Promise.all([
    observe(() => page.evaluate(() => ({
      url: location.href, readyState: document.readyState, status: document.querySelector("#status")?.textContent ?? null,
      published: Boolean(Reflect.get(globalThis, "playground")),
      resources: performance.getEntriesByType("resource").length,
      navigation: performance.getEntriesByType("navigation").map(entry => entry.toJSON()),
    }))),
    observe(() => probeServer(url)),
  ]);
  const report = { browser, budget: process.env.QUICKJS_STACK_KIB ?? "default", url, error: String(error), pageAtFailure, requests, pageState, server };
  const json = JSON.stringify(report, null, 2);
  console.error(`QuickJS stack navigation failed\n${json}`);
  const directory = process.env.BUN_WASM_BROWSER_REPORT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `quickjs-stack-navigation-${browser}-${process.pid}-${Date.now()}.json`), `${json}\n`);
}

export async function openQuickjsStackPage(page: Page, url: string): Promise<void> {
  const target = `${url}?engine=quickjs&prompt=off&mode=memory`;
  const requests = navigationRequests(page);
  // Runtime publication below decides readiness; unrelated resources need not finish loading.
  try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
  catch (error) {
    const diagnostic = await observe(() => reportFailure(page, target, error, requests.snapshot()), 15_000);
    if (diagnostic.outcome === "error") console.error("QuickJS navigation diagnostic failed:", diagnostic.error);
    throw error;
  } finally { requests.stop(); }
  await ready(page, 90_000);
}
