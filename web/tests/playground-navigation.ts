import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Frame, Page, Request, Response } from "playwright";
import { ready } from "./playground.mjs";
import { navigationParameter, readNavigationServerLog } from "../navigation-server-log.ts";

async function observe<T>(read: () => Promise<T>, hangCap = 5_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`diagnostic observation exceeded its ${hangCap} ms hang cap`)), hangCap); });
  try { return { outcome: "ok", value: await Promise.race([read(), expired]) } as const; }
  catch (error) { return { outcome: "error", error: String(error) } as const; }
  finally { clearTimeout(timer); }
}

function navigationRequests(page: Page) {
  const startedAt = Date.now();
  const started = performance.now();
  const pending = new Set<Request>();
  const lifecycle = { documentCommitted: false, domcontentloaded: false, load: false };
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
  const committed = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    lifecycle.documentCommitted = true;
    record("commit", frame.url());
  };
  const domcontentloaded = () => { lifecycle.domcontentloaded = true; record("domcontentloaded", page.url()); };
  const load = () => { lifecycle.load = true; record("load", page.url()); };
  const crash = () => { record("crash", page.url()); };
  const pageerror = (error: Error) => { record("pageerror", page.url(), error.message); };
  page.on("request", request).on("response", response).on("requestfinished", finished).on("requestfailed", failed);
  page.on("framenavigated", committed).on("domcontentloaded", domcontentloaded).on("load", load);
  page.on("crash", crash).on("pageerror", pageerror);
  return {
    snapshot: () => ({ requested, startedAt, elapsedMs: performance.now() - started, pending: Array.from(pending, request => request.url()), events: events.slice(), lifecycle: { ...lifecycle } }),
    stop() {
      page.off("request", request).off("response", response).off("requestfinished", finished).off("requestfailed", failed);
      page.off("framenavigated", committed).off("domcontentloaded", domcontentloaded).off("load", load);
      page.off("crash", crash).off("pageerror", pageerror);
    },
  };
}

async function probeServer(url: string) {
  // This is an independent request; only the page's events describe its navigation.
  const started = performance.now();
  const independent = new URL(url);
  independent.searchParams.delete(navigationParameter);
  const response = await fetch(independent, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
  const body = await response.arrayBuffer();
  return { status: response.status, bytes: body.byteLength, elapsedMs: performance.now() - started };
}

type Diagnostic = { prefix: string; title: string; fields: Readonly<Record<string, string>> };
type Stage = "navigation" | "runtime-publication";
type WaitUntil = "load" | "domcontentloaded";

async function reportFailure(page: Page, url: string, error: unknown, requests: ReturnType<ReturnType<typeof navigationRequests>["snapshot"]>, stage: Stage, diagnostic: Diagnostic, waitUntil: WaitUntil) {
  const browser = page.context().browser()?.browserType().name() ?? "disconnected";
  const pageAtFailure = { url: page.url(), closed: page.isClosed(), browserConnected: page.context().browser()?.isConnected() ?? false };
  const id = new URL(url).searchParams.get(navigationParameter);
  const originalServerRequest = id ? await observe(() => readNavigationServerLog(id, url)) : { outcome: "disabled" };
  const [pageState, server] = await Promise.all([
    observe(() => page.evaluate(() => ({
      url: location.href, readyState: document.readyState, status: document.querySelector("#status")?.textContent ?? null,
      published: Boolean(Reflect.get(globalThis, "playground")),
      resources: performance.getEntriesByType("resource").length,
      navigation: performance.getEntriesByType("navigation").map(entry => entry.toJSON()),
    }))),
    observe(() => probeServer(url)),
  ]);
  const report = { ...diagnostic.fields, browser, url, error: String(error), stage, waitUntil, pageAtFailure, requests, pageState, originalServerRequest, server };
  const json = JSON.stringify(report, null, 2);
  console.error(`${diagnostic.title} failed\n${json}`);
  const directory = process.env.BUN_WASM_BROWSER_REPORT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${diagnostic.prefix}-${browser}-${process.pid}-${Date.now()}.json`), `${json}\n`);
}

export async function openPlaygroundPage(page: Page, target: string, options: { readyTimeout?: number; diagnostic?: Diagnostic; waitUntil?: WaitUntil } = {}): Promise<string> {
  if (process.env.BUN_WASM_NAVIGATION_LOG) {
    const correlated = new URL(target);
    correlated.searchParams.set(navigationParameter, crypto.randomUUID());
    target = correlated.href;
  }
  const diagnostic = options.diagnostic ?? { prefix: "playground-navigation", title: "Playground navigation", fields: {} };
  const requests = navigationRequests(page);
  const waitUntil = options.waitUntil ?? "domcontentloaded";
  let stage: Stage = "navigation";
  // Runtime publication below decides readiness; unrelated resources need not finish loading.
  try {
    await page.goto(target, { waitUntil, timeout: 30_000 });
    stage = "runtime-publication";
    return await ready(page, options.readyTimeout);
  } catch (error) {
    const result = await observe(() => reportFailure(page, target, error, requests.snapshot(), stage, diagnostic, waitUntil), 15_000);
    if (result.outcome === "error") console.error(`${diagnostic.title} diagnostic failed:`, result.error);
    throw error;
  } finally { requests.stop(); }
}
