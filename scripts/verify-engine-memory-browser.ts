import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
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
    try { await browser?.close(); }
    finally {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
      await closed;
    }
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


async function waitMarker(page: Page, engine: string, marker: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await terminalText(page)).includes(marker)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Missing ${engine} marker ${marker}: ${await terminalText(page)}`);
}
async function startFixture(page: Page, path: string, code: string): Promise<void> {
  await writeFile(page, path, code);
  await page.evaluate(path => {
    const playground: unknown = Reflect.get(globalThis, "playground");
    if (!playground || typeof playground !== "object") throw new Error("Missing playground");
    const shell: unknown = Reflect.get(playground, "shell");
    if (!shell || typeof shell !== "object") throw new Error("Missing shell");
    const submit: unknown = Reflect.get(shell, "submit");
    if (typeof submit !== "function") throw new Error("Missing shell submit");
    void submit.call(shell, `bun run ${path}`);
  }, path);
}
const failedBytes = 600 * 1024 * 1024;
const gate = `import fs from 'node:fs'; async function gate(name) { while (!fs.existsSync('/home/user/'+name)) await Bun.sleep(20); }`;
function exactFailure(value: Awaited<ReturnType<typeof sample>>, engine: "quickjs" | "jsc"): string {
  assert.deepEqual(value.failedAllocation, { bytes: failedBytes, category: engine === "quickjs" ? "quickjs.arrayBuffer" : "jsc.typedArray" });
  assert(value.failureProcessId, "failed process identity retained");
  assert(value.processes.some(process => process.id === value.failureProcessId));
  return value.failureProcessId;
}
function sequence(value: Awaited<ReturnType<typeof sample>>, id: string): unknown {
  const process = value.processes.find(process => process.id === id);
  if (!process) throw new Error(`Missing process ${id}`);
  const counters: unknown = Reflect.get(process, "engineCounters");
  if (!counters || typeof counters !== "object") throw new Error("Missing engine counters");
  return Reflect.get(counters, "refreshSequence");
}
function saveProgress(value: unknown): void { writeFileSync(join(output, "hook-progress.json"), JSON.stringify(value, null, 2) + "\n"); }
async function verifyEngine(browser: Browser, url: string, engine: "quickjs" | "jsc") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`${url}?engine=${engine}`);
    assert.match(await ready(page), /ready/);
    await startFixture(page, "/home/user/memory-producer.ts", `${gate}
      console.log('memory-baseline'); await gate('busy');
      console.log('memory-busy-start'); const until = Date.now()+5000; while(Date.now()<until) {}
      console.log('memory-busy-end'); await gate('allocate');
      globalThis.kept = new Uint8Array(1048576); console.log('memory-allocated'); await gate('fail');
      try { globalThis.failed = new Uint8Array(${failedBytes}); } catch(e) { console.log('memory-failure'); }
      await gate('stop'); console.log('memory-finished');`);
    await waitMarker(page, engine, "memory-baseline");
    const baseline = await sample({ page, phase: "baseline", engine });
    await writeFile(page, "/home/user/busy", "1");
    await waitMarker(page, engine, "memory-busy-start");
    const samplingStarted = Date.now();
    const busy = await sample({ page, phase: "compile:busy", engine });
    assert(Date.now() - samplingStarted < 4000, "busy-worker sampling stays on the responsive host");
    assert(busy.allocatorLiveBytes !== null, "busy cached allocator read is available");
    await waitMarker(page, engine, "memory-busy-end");
    await writeFile(page, "/home/user/allocate", "1");
    await waitMarker(page, engine, "memory-allocated");
    const allocated = await sample({ page, phase: "allocated", engine });
    saveProgress({ engine, baseline, busy, allocated });
    assert(allocated.allocatorLiveBytes !== null && baseline.allocatorLiveBytes !== null);
    assert(allocated.allocatorLiveBytes > baseline.allocatorLiveBytes, "allocator moves on real buffer allocation");
    assert(allocated.allocatorPeakBytes !== null && allocated.allocatorPeakBytes >= allocated.allocatorLiveBytes);
    assert(allocated.jsHeapBytes !== null, "actual engine heap readout");
    if (engine === "quickjs") assert(allocated.arrayBufferBytes !== null && allocated.arrayBufferBytes >= 1048576);
    else assert.equal(allocated.arrayBufferBytes, null);
    await writeFile(page, "/home/user/fail", "1");
    await waitMarker(page, engine, "memory-failure");
    const failure = await sample({ page, phase: "failure", engine });
    saveProgress({ engine, baseline, busy, allocated, failure });
    const failedId = exactFailure(failure, engine);
    assert.equal(sequence(failure, failedId), sequence(allocated, failedId), "failure read never refreshes the VM");
    await writeFile(page, "/home/user/stop", "1");
    await waitMarker(page, engine, "memory-finished");
    await stopForeground(page);
    const terminal = await sample({ page, phase: "terminal", engine });
    assert.equal(exactFailure(terminal, engine), failedId);
    assert(terminal.processes.find(process => process.id === failedId)?.terminal);
    assert.equal(sequence(terminal, failedId), sequence(failure, failedId));
    const child = await verifyFailedChild(page, engine);
    const result = { engine, baseline, busy, allocated, failure, terminal, child, errors, terminalText: await terminalText(page) };
    assert.deepEqual(errors, []);
    return result;
  } finally {
    await stopForeground(page).catch(() => {});
    await context.close();
  }
}
async function verifyFailedChild(page: Page, engine: "quickjs" | "jsc") {
  await writeFile(page, "/home/user/memory-child.ts", `${gate}
    console.log('memory-child-live'); await gate('child-fail');
    try { globalThis.failed = new Uint8Array(${failedBytes}); } catch(e) { console.log('memory-child-failed'); }`);
  await startFixture(page, "/home/user/memory-parent.ts", `${gate}
    const child = Bun.spawn([process.execPath, 'run', '/home/user/memory-child.ts'], { stdout:'inherit', stderr:'inherit' });
    console.log('memory-parent-live'); await child.exited; console.log('memory-child-ended');
    await gate('parent-stop'); console.log('memory-parent-finished');`);
  await waitMarker(page, engine, "memory-child-live");
  const live = await sample({ page, phase: "parent:idle", engine });
  assert.equal(live.failedAllocation, null, "previous command failure must not contaminate this command");
  await writeFile(page, "/home/user/child-fail", "1");
  await waitMarker(page, engine, "memory-child-ended");
  const failure = await sample({ page, phase: "child:failure", engine });
  saveProgress({ engine, live, childFailure: failure });
  const failedId = exactFailure(failure, engine);
  assert(failure.processes.some(process => !process.terminal && process.id !== failedId), "parent remains live");
  assert(failure.processes.find(process => process.id === failedId)?.terminal, "failed child remains visible after exit");
  assert.equal(sequence(failure, failedId), sequence(live, failedId));
  await writeFile(page, "/home/user/parent-stop", "1");
  await waitMarker(page, engine, "memory-parent-finished");
  await stopForeground(page);
  const terminal = await sample({ page, phase: "parent:terminal", engine });
  assert.equal(exactFailure(terminal, engine), failedId);
  assert(terminal.processes.every(process => process.terminal));
  return { live, failure, terminal };
}
