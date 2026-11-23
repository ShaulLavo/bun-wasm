import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ChildGroup, installPageLoadObserver, requireUniqueNames, type PageLoadState } from "../../sandbox/tests/page-load-support";

declare const __pageLoad: { state(app: string): PageLoadState };

const pages: Record<string, string> = {
  // A playground from before the stage marks: only #status says when it is ready.
  "/unmarked": `<span id="status" data-kind="">loading…</span><script>setTimeout(() => {
    const status = document.querySelector("#status"); status.textContent = "bun.wasm ready · Browser"; status.dataset.kind = "ok";
  }, 30)</script>`,
  "/marked": `<span id="status" data-kind="">loading…</span><script>setTimeout(() => {
    performance.mark("bunwasm:status", { detail: "bun.wasm ready · Browser" });
    globalThis.markedAt = performance.getEntriesByName("bunwasm:status")[0].startTime;
  }, 30)</script>`,
  "/failed": `<span id="status" data-kind="">loading…</span><script>setTimeout(() => {
    const status = document.querySelector("#status"); status.textContent = "could not load bun.wasm"; status.dataset.kind = "error";
  }, 30)</script>`,
};

test("page readiness comes from the page's marks, or from #status on builds without them", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new Response(pages[new URL(request.url).pathname] ?? "", { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(installPageLoadObserver);
    const page = await context.newPage();
    const state = async (path: string) => {
      await page.goto(`${server.url.origin}${path}`);
      await page.waitForFunction(() => __pageLoad.state("web").ready !== null || __pageLoad.state("web").error !== null, undefined, { timeout: 10_000 });
      return page.evaluate(() => ({ ...__pageLoad.state("web"), markedAt: Reflect.get(globalThis, "markedAt") as number | undefined }));
    };
    const unmarked = await state("/unmarked");
    expect(unmarked.ready).toBeGreaterThan(0);
    expect(unmarked.error).toBeNull();
    const marked = await state("/marked");
    expect(marked.ready).toBe(marked.markedAt!);
    const failed = await state("/failed");
    expect(failed.ready).toBeNull();
    expect(failed.error).toBe("could not load bun.wasm");
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60_000);

test("variants with the same name are refused before anything starts", () => {
  expect(() => requireUniqueNames(["before", "after"])).not.toThrow();
  expect(() => requireUniqueNames(["before", "before"])).toThrow("Variant before is named twice");
});

test("a server that ignores SIGTERM is killed and its exit awaited", async () => {
  const group = new ChildGroup();
  const child = group.spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>(resolveUp => child.stdout!.once("data", () => resolveUp()));
  await group.stop(200);
  expect(child.signalCode).toBe("SIGKILL");
});

test("interrupting the profiler stops the servers it started", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-page-load-interrupt-"));
  try {
    const script = join(scratch, "interrupted.ts");
    const support = join(import.meta.dir, "../../sandbox/tests/page-load-support.ts");
    await writeFile(script, `import { ChildGroup, onInterrupt } from ${JSON.stringify(support)};
const group = new ChildGroup();
const server = group.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
onInterrupt(() => group.stop(2000));
console.log(server.pid);
setInterval(() => {}, 1000);
`);
    const profiler = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const pid = Number(await new Promise<string>(resolvePid => profiler.stdout!.once("data", (chunk: Buffer) => resolvePid(chunk.toString().trim()))));
    const exited = new Promise<number | null>(resolveExit => profiler.once("exit", code => resolveExit(code)));
    profiler.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 30_000);
