import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType } from "playwright";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "./goals-matrix/execute.ts";
import { frameworks } from "./goals-matrix/catalog.ts";
import type { Transport } from "./goals-matrix/transport.ts";

async function control(engine: BrowserType, ownedCleanup: boolean, imported: boolean): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-browser-trap-"));
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<BrowserType["launch"]>> | undefined;
  try {
    const build = await Bun.build({ entrypoints: [new URL("./fixtures/browser-call-trap-page.ts", import.meta.url).pathname, new URL("./fixtures/browser-call-trap-worker.ts", import.meta.url).pathname], outdir: scratch, target: "browser" });
    if (!build.success) throw new AggregateError(build.logs, "Control build failed");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      const headers = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" };
      if (path === "/") return new Response('<select id="engine"><option>browser</option></select><div id="status">Browser (native) ready</div><script type="module" src="/page.js"></script>', { headers: { ...headers, "content-type": "text/html" } });
      const asset = path === "/page.js" ? "browser-call-trap-page.js" : path === "/worker.js" ? "browser-call-trap-worker.js" : null;
      return asset ? new Response(Bun.file(join(scratch, asset)), { headers }) : new Response("not found", { status: 404 });
    } });
    browser = await engine.launch({ headless: true });
    const page = await browser.newPage();
    let savedBeforeClose = 0;
    const transport: Transport = {
      capabilities: { browserName: engine.name(), transport: "real-wasm-worker-control" },
      async navigate(url) { await page.goto(url); await page.waitForFunction(() => Reflect.get(globalThis, "__browserTrapControlReady") === true); },
      evaluate: expression => page.evaluate(expression),
      async useHost() {}, async usePreview() {}, async openPreview() {}, async closePreview() {},
      async close() { await page.close(); },
    };
    if (ownedCleanup) transport.cleanup = async () => { await page.close(); return { browserClosed: true, foregroundStopped: true, previewClosed: true }; };
    const framework = frameworks.find(value => value.id === "next");
    if (!framework) throw Error("Missing Next matrix definition");
    const log = join(scratch, "matrix.log");
    const result = await execute({ framework, box: { framework: "next", browser: "chrome", engine: "browser" }, url: `${server.url}?engine=browser&memory=${imported ? "imported" : "defined"}`, timeoutMs: 5000, startupTimeoutMs: 5000,
      async createTransport() { return transport; }, async saveLog(text) {
        expect(page.isClosed()).toBe(false);
        expect(await page.evaluate(() => Reflect.get(globalThis, "__browserTrapControl"))).toEqual({ type: "control-done", sameError: true, runtimeError: true, exits: 0,
          fixtureFactoryMaximumBytes: (imported ? 4 : 8) * 65536 });
        await Bun.write(log, text);
        savedBeforeClose++;
      },
    });
    expect(result).toMatchObject({ status: "fail", phase: "install" });
    expect(result.attempts[0]?.phases.find(value => value.phase === "cleanup")).toMatchObject({ status: "pass" });
    expect(savedBeforeClose).toBeGreaterThan(0);
    expect(page.isClosed()).toBe(true);
    const saved = readFileSync(log, "utf8");
    expect(saved).toContain('"browserCallTrapCapacityBytes":131072');
    expect(saved).toContain('"browserCoreDeclaredMaximumBytes":524288');
    expect(saved).toContain(`"browserCoreFactoryMaximumBytes":${imported ? "null" : "524288"}`);
    expect(saved).toContain('"terminal":true');
    const destination = process.env.BUN_BROWSER_TRAP_REPORT;
    if (destination) {
      const label = `${engine.name()}-${ownedCleanup ? "owned" : "ordinary"}-${imported ? "imported" : "defined"}`;
      await Bun.write(join(destination, `${label}.log`), saved);
      await Bun.write(join(destination, `${label}.json`), JSON.stringify({ result, fixtureDeclaredMaximumBytes: 8 * 65536,
        fixtureFactoryMaximumBytes: (imported ? 4 : 8) * 65536, savedBeforeClose, pageClosed: page.isClosed() }, null, 2));
    }
  } finally {
    await browser?.close();
    await server?.stop(true);
    rmSync(scratch, { recursive: true, force: true });
  }
}

const cases = [chromium, webkit].flatMap(engine => [false, true].flatMap(owned => [false, true].map(imported => ({ engine, owned, imported }))));
for (const { engine, owned, imported } of cases) test(`${engine.name()} ${imported ? "imported" : "defined"} Wasm worker trap is saved before ${owned ? "owned" : "ordinary"} matrix cleanup`, () => control(engine, owned, imported), 30_000);
