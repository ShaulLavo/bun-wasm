import { expect, test } from "bun:test";
import { chromium, firefox, webkit, type Browser, type Page } from "playwright";
import { gzipSync } from "node:zlib";
import { installToolsRoute } from "../web/tests/tools-route.ts";
import { navigateTestPage } from "../web/tests/navigate-test-page.ts";

const rejected = gzipSync("intentionally different guest");
const verified = gzipSync("verified tools fixture");
const browsers = { chromium, firefox, webkit };

async function response(page: Page, path: string) {
  return page.evaluate(async path => {
    const result = await fetch(path);
    return { status: result.status, type: result.headers.get("content-type"), bytes: Array.from(new Uint8Array(await result.arrayBuffer())) };
  }, path);
}

test.each(["chromium", "firefox", "webkit"] as const)("%s tools route keeps exact bytes and page scope through verification and reload", async name => {
  const requests: string[] = [];
  const server = fixture(requests);
  let browser: Browser | undefined;
  try {
    browser = await browsers[name].launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    const useVerifiedTools = await installToolsRoute(page, rejected);
    await navigateTestPage(page, server.url.href);
    expect((await response(page, "/other.wasm.gz")).bytes).toEqual(Array.from(verified));
    expect((await response(page, "/bun-tools.wasm")).bytes).toEqual(Array.from(verified));
    const peer = await page.context().newPage();
    await navigateTestPage(peer, server.url.href);
    expect((await response(peer, "/bun-tools.wasm.gz?v=peer")).bytes).toEqual(Array.from(verified));
    for (const path of ["/bun-tools.wasm.gz", "/bun-tools.wasm.gz?v=expected"]) {
      expect(await response(page, path)).toEqual({ status: 200, type: "application/wasm", bytes: Array.from(rejected) });
      expect(requests).not.toContain(path);
    }
    useVerifiedTools();
    expect((await response(page, "/bun-tools.wasm.gz?v=verified")).bytes).toEqual(Array.from(verified));
    expect(requests).toContain("/bun-tools.wasm.gz?v=verified");
    await page.reload();
    useVerifiedTools();
    expect((await response(page, "/bun-tools.wasm.gz?v=reload")).bytes).toEqual(Array.from(verified));
    expect(requests).toContain("/bun-tools.wasm.gz?v=reload");
  } finally { await browser?.close(); await server.stop(true); }
}, 30_000);

function fixture(requests: string[]) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(url.pathname + url.search);
      if (url.pathname !== "/") return new Response(verified, { headers: { "content-type": "application/wasm" } });
      return new Response("<title>Tools route fixture</title>", { headers: { "content-type": "text/html", "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" } });
    },
  });
}

// (module (import "env" "memory" (memory 1 1 shared))
//   (func (export "run") (loop $again (br_if $again (i32.eqz (i32.atomic.load (i32.const 0)))))))
const spin = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 16, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 3, 1, 1,
  3, 2, 1, 0, 7, 7, 1, 3, 114, 117, 110, 0, 0, 10, 16, 1, 14, 0, 3, 64, 65, 0, 254, 16, 2, 0, 69, 13, 0, 11, 11];

async function terminateWorker(page: Page) {
  const created = page.waitForEvent("worker");
  await page.evaluate(startWorker, spin);
  const worker = await created;
  const closed = worker.waitForEvent("close");
  await page.evaluate(() => Reflect.get(globalThis, "toolsRouteWorker").terminate());
  return { closed };
}

async function startWorker(bytes: number[]): Promise<void> {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const source = `onmessage = async ({data}) => {
    const {instance} = await WebAssembly.instantiate(new Uint8Array(${JSON.stringify(bytes)}), {env: {memory: data}});
    postMessage("running"); instance.exports.run();
  };`;
  const url = URL.createObjectURL(new Blob([source]));
  const worker = new Worker(url);
  Reflect.set(globalThis, "toolsRouteWorker", worker);
  try { await new Promise<void>((done, reject) => { worker.onmessage = () => done(); worker.onerror = reject; worker.postMessage(memory); }); }
  finally { URL.revokeObjectURL(url); }
}

test("early tools routing switches payloads while an ordinary worker terminates and drains on close", async () => {
  const requests: string[] = [], server = fixture(requests);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const useVerifiedTools = await installToolsRoute(page, rejected);
    await navigateTestPage(page, server.url.href);
    const { closed } = await terminateWorker(page);
    expect((await response(page, "/bun-tools.wasm.gz?v=negative")).bytes).toEqual(Array.from(rejected));
    useVerifiedTools();
    expect((await response(page, "/bun-tools.wasm.gz?v=positive")).bytes).toEqual(Array.from(verified));
    expect(requests).not.toContain("/bun-tools.wasm.gz?v=negative");
    expect(requests).toContain("/bun-tools.wasm.gz?v=positive");
    await page.close();
    await closed;
    expect(page.isClosed()).toBe(true);
    expect(page.workers()).toEqual([]);
  } finally { await browser?.close(); await server.stop(true); }
}, 30_000);
