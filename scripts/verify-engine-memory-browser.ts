import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { sample } from "./app-matrix/engine-memory-hook.ts";
import { ready, terminalText, writeFile } from "../web/tests/playground.mjs";
import { stopForeground } from "../web/tests/foreground.ts";

const repository = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? "/work/tmp/bun-wasm-wave1029-engines-current");
const serverLog = join(output, "hook-server.log");
let browser: Browser | undefined;
const server = spawn(process.execPath, [join(repository, "web/serve.ts")], {
  cwd: repository, env: { ...process.env, ROOT: join(output, "web"), PORT: "0", HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverText = "";
server.stdout.on("data", data => { serverText += String(data); writeFileSync(serverLog, serverText); });
server.stderr.on("data", data => { serverText += String(data); writeFileSync(serverLog, serverText); });
const closed = new Promise<void>(done => server.once("close", () => done()));
let cleaning: Promise<void> | undefined;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await closed;
  })();
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(130)); });
const results: unknown[] = [];
try {
  let url: string | undefined;
  for (let attempt = 0; attempt < 100 && !url; attempt++) {
    url = serverText.match(/at (http:\/\/\S+)/)?.[1];
    if (!url) await Bun.sleep(50);
  }
  assert(url, "producer smoke server started");
  browser = await chromium.launch({ headless: true });
  for (const engine of ["quickjs", "jsc"] as const) results.push(await verifyEngine(browser, url, engine));
  writeFileSync(join(output, "hook-smoke.json"), JSON.stringify({ browser: browser.version(), results }, null, 2) + "\n");
} finally {
  await cleanup();
  writeFileSync(join(output, "hook-cleanup.json"), JSON.stringify({ serverPid: server.pid, serverExited: server.exitCode !== null || server.signalCode !== null, browserClosed: !browser?.isConnected() }) + "\n");
}

async function verifyEngine(browser: Browser, url: string, engine: "quickjs" | "jsc") {
  const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`${url}?engine=${engine}`);
      assert.match(await ready(page), /ready/);
      const code = `import fs from 'node:fs';
        async function gate(name) { while (!fs.existsSync('/home/user/'+name)) await Bun.sleep(20); }
        console.log('memory-baseline'); await gate('allocate');
        globalThis.kept = new Uint8Array(1048576); console.log('memory-allocated'); await gate('fail');
        try { globalThis.failed = new Uint8Array(600*1024*1024); } catch(e) { console.log('memory-failure'); }
        await gate('stop'); console.log('memory-finished');`;
      await writeFile(page, "/home/user/memory-producer.ts", code);
      await page.evaluate(() => {
        const playground: unknown = Reflect.get(globalThis, "playground");
        if (!playground || typeof playground !== "object") throw new Error("Missing playground");
        const shell: unknown = Reflect.get(playground, "shell");
        if (!shell || typeof shell !== "object") throw new Error("Missing shell");
        const submit: unknown = Reflect.get(shell, "submit");
        if (typeof submit !== "function") throw new Error("Missing shell submit");
        void submit.call(shell, "bun run /home/user/memory-producer.ts");
      });
      const wait = async (marker: string) => {
        for (let attempt = 0; attempt < 300; attempt++) {
          if ((await terminalText(page)).includes(marker)) return;
          await Bun.sleep(100);
        }
        throw new Error(`Missing ${engine} marker ${marker}: ${await terminalText(page)}`);
      };
      await wait("memory-baseline");
      const baseline = await sample({ page, phase: "baseline", engine });
      await writeFile(page, "/home/user/allocate", "1");
      await wait("memory-allocated");
      const allocated = await sample({ page, phase: "allocated", engine });
      assert(allocated.allocatorLiveBytes !== null && baseline.allocatorLiveBytes !== null);
      assert(allocated.allocatorLiveBytes > baseline.allocatorLiveBytes, "allocator moves on real buffer allocation");
      assert(allocated.allocatorPeakBytes !== null && allocated.allocatorPeakBytes >= allocated.allocatorLiveBytes);
      assert(allocated.jsHeapBytes !== null, "actual engine heap readout");
      if (engine === "quickjs") assert(allocated.arrayBufferBytes !== null && allocated.arrayBufferBytes >= 1048576);
      else assert.equal(allocated.arrayBufferBytes, null);
      await writeFile(page, "/home/user/fail", "1");
      await wait("memory-failure");
      const failure = await sample({ page, phase: "failure", engine });
      assert(failure.failedAllocation && failure.failedAllocation.bytes !== null, "original failed request survives error construction");
      assert(failure.failedAllocation.bytes >= 600 * 1024 * 1024);
      await writeFile(page, "/home/user/stop", "1");
      await wait("memory-finished");
      await stopForeground(page);
      const terminal = await sample({ page, phase: "terminal", engine });
      const result = { engine, baseline, allocated, failure, terminal, errors, terminalText: await terminalText(page) };
      assert.deepEqual(errors, []);
      return result;
    } finally {
      await stopForeground(page).catch(() => {});
      await context.close();
    }
}
