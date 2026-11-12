import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Browser, type CDPSession } from "playwright";

async function waitWorkers(count: () => Promise<number>, expected: number) {
  const deadline = performance.now() + 3000;
  while (await count() !== expected && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(await count()).toBe(expected);
}

async function settledWorkers(count: () => Promise<number>) {
  const deadline = performance.now() + 1000;
  while (await count() !== 0 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return count();
}

async function cpu(cdp: CDPSession) {
  try { return { processes: (await cdp.send("SystemInfo.getProcessInfo")).processInfo, unavailable: null }; }
  catch (error) { return { processes: [], unavailable: String(error) }; }
}

function cpuDelta(before: Awaited<ReturnType<typeof cpu>>, after: Awaited<ReturnType<typeof cpu>>, wallMs: number) {
  if (before.unavailable || after.unavailable) return { unavailable: before.unavailable ?? after.unavailable };
  const remaining = new Set(after.processes.map(process => process.id));
  if (before.processes.some(process => !remaining.has(process.id))) return { unavailable: "A browser process exited inside the measured interval" };
  const previous = new Map(before.processes.map(process => [process.id, process.cpuTime]));
  const seconds = after.processes.reduce((total, process) => total + process.cpuTime - (previous.get(process.id) ?? 0), 0);
  return { seconds, percentOfOneCore: seconds / (wallMs / 1000) * 100, scope: "all Chrome browser, renderer and helper processes; includes Workers and fixture publisher" };
}

test("matched current Waffle component Worker cost and lifetime", async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-wait-cost-"));
  let browser: Browser | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const build = await Bun.build({ target: "browser", entrypoints: [
      "web/tests/fixtures/mixed-resource-page.ts", "web/tests/fixtures/mixed-resource-worker.ts", "web/src/notification-worker.ts",
    ], outdir: scratch, naming: "[name].js" });
    expect(build.success).toBe(true);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
      if (path === "/") return new Response('<script type="module" src="/mixed-resource-page.js"></script>', { headers: { ...headers, "Content-Type": "text/html" } });
      return new Response(Bun.file(join(scratch, path)), { headers });
    } });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForFunction(() => "start" in globalThis);
    const cdp = await browser.newBrowserCDPSession();
    const workers = async () => (await cdp.send("Target.getTargets")).targetInfos.filter(target => target.type === "worker").length;
    const rows: unknown[] = [];
    for (let pair = 0; pair < 2; pair++) await cpuPair(pair);
    for (const combined of [false, true]) await measure(combined);
    console.log(JSON.stringify({ component: "current source and consumed Waffle", rows, memory: "unmeasured; no reliable per-Worker memory API" }));
    expect(await workers()).toBe(0);

    async function measure(combined: boolean) {
      for (const lifecycle of ["exit", "failed-start", "cancel", "dispose"] as const) {
        await page.evaluate(([changed, fail]) => Reflect.get(globalThis, "start")(changed, 3, fail), [combined, lifecycle === "failed-start"]);
        // Wait for the real nested waiter targets to appear, not an assumed per-Worker byte estimate.
        const expected = combined ? 15 : 12;
        await waitWorkers(workers, expected);
        const live = await workers();
        const result = lifecycle === "exit" || lifecycle === "failed-start" ? await page.evaluate(() => Reflect.apply(Reflect.get(globalThis, "run"), globalThis, [true]), undefined) : null;
        await page.evaluate(() => Reflect.get(globalThis, "cleanup")(), undefined);
        const afterCleanup = await settledWorkers(workers);
        rows.push({ combined, lifecycle, live, observedPeak: live, afterCleanup, result });
        await resetDocument(afterCleanup);
      }
    }

    async function cpuPair(pair: number) {
      for (const combined of [false, true]) {
        await interval(pair, combined, false);
        await interval(pair, combined, true);
      }
    }

    async function interval(pair: number, combined: boolean, noise: boolean) {
      try {
        await page.evaluate(([changed, duration]) => Reflect.get(globalThis, "start")(changed, 3, false, duration), [combined, 3000]);
        await waitWorkers(workers, combined ? 15 : 12);
        const live = await workers();
        const before = await cpu(cdp), start = performance.now();
        const result = await page.evaluate(noisy => Reflect.apply(Reflect.get(globalThis, "run"), globalThis, [noisy]), noise);
        const elapsed = performance.now() - start, after = await cpu(cdp);
        rows.push({ pair, combined, noise, intervalMs: elapsed, live, observedPeak: Math.max(live, await workers()), cpu: cpuDelta(before, after, elapsed), result });
      } finally { await page.evaluate(() => Reflect.get(globalThis, "cleanup")(), undefined); }
      const afterCleanup = await settledWorkers(workers);
      console.log(JSON.stringify({ cleanupAfterCpuInterval: { pair, combined, noise, afterCleanup } }));
      await resetDocument(afterCleanup);
    }

    async function resetDocument(remaining: number) {
      if (remaining === 0) return;
      await page.goto("about:blank");
      await waitWorkers(workers, 0);
      await page.goto(`http://127.0.0.1:${server!.port}`);
      await page.waitForFunction(() => "start" in globalThis);
    }
  } finally { await browser?.close(); server?.stop(true); await rm(scratch, { recursive: true, force: true }); }
}, 60000);
