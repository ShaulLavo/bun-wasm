import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { ENGINE_BIN } from "../src/executable-paths.ts";
import { maxMemoryBytes } from "./src/program-profile.ts";
import { sample } from "./app-matrix/engine-memory-hook.ts";
import { ready, terminalText, writeFile } from "../web/tests/playground.mjs";
import { stopForeground } from "../web/tests/foreground.ts";

export const failedBytes = maxMemoryBytes() + 64 * 1024 * 1024;
export const fixtureAllocationBytes = 8 * 1024 * 1024;
const gate = `import fs from 'node:fs'; async function gate(name) { while (!fs.existsSync('/home/user/'+name)) await Bun.sleep(20); }`;

const repository = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? "/work/tmp/bun-wasm-wave1029-engines-current");
async function main(): Promise<void> {
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
type Engine = "quickjs" | "jsc";
type Sample = Awaited<ReturnType<typeof sample>>;
export interface Actor { authority: "host-worker-launch"; id: string; engine: Engine; path: string }
const producerPath = "/home/user/memory-producer.ts";
const parentPath = "/home/user/memory-parent.ts";
const childPath = "/home/user/memory-child.ts";

// Runs in the page before application startup. This observes the host's actual launch transport,
// not command grouping or ancestry. It supplies no root inventory and cannot authorize totals.
export function installActorObserver({ engine, executable, paths }: { engine: Engine; executable: string; paths: readonly string[] }): void {
  const observations: unknown[] = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...args: [message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions]) {
    const message: unknown = args[0];
    const result = Reflect.apply(post, this, args);
    if (!message || typeof message !== "object" || !("args" in message) || !Array.isArray(message.args)) return result;
    const argv: unknown[] = message.args;
    if (!paths.includes(String(argv[2]))) return result;
    const telemetry: unknown = Reflect.get(message, "memoryTelemetry");
    const env: unknown = Reflect.get(message, "env");
    // The launcher preserves shell argv[0] and overwrites this authority from the admitted executable.
    const executableMatches = env && typeof env === "object" && Reflect.get(env, "BUNWASM_EXEC_PATH") === executable;
    const valid = executableMatches && argv.length === 3 && (argv[0] === "bun" || argv[0] === executable) && argv[1] === "run" && Reflect.get(message, "engine") === engine
      && telemetry && typeof telemetry === "object" && "id" in telemetry && typeof telemetry.id === "string" && telemetry.id.length > 0
      && "buffer" in telemetry && telemetry.buffer instanceof SharedArrayBuffer;
    observations.push(valid ? { authority: "host-worker-launch", id: telemetry.id, engine, path: argv[2] }
      : { path: argv[2], error: "invalid host fixture launch transport" });
    return result;
  };
  Object.defineProperty(globalThis, "__bunMemoryVerifierActors", { configurable: true, value: () => observations.slice() });
}
export function selectActor(observations: unknown, expected: Pick<Actor, "engine" | "path">): Actor {
  assert(Array.isArray(observations), "host launch observations unavailable");
  assert(expected.engine === "quickjs" || expected.engine === "jsc", "only supported paired engines QJS/JSC are qualified");
  const matches = observations.filter((value: unknown) => value && typeof value === "object" && Reflect.get(value, "path") === expected.path);
  assert.equal(matches.length, 1, `unique host fixture launch required: ${expected.path}`);
  const value: unknown = matches[0];
  assert(value && typeof value === "object" && !("error" in value), "valid host fixture launch required");
  assert("authority" in value && value.authority === "host-worker-launch", "host launch authority required");
  assert("id" in value && typeof value.id === "string" && value.id.length > 0, "telemetry transport identity required");
  assert("engine" in value && value.engine === expected.engine, "fixture engine must match");
  assert.equal(observations.filter((entry: unknown) => entry && typeof entry === "object" && Reflect.get(entry, "id") === value.id).length, 1, "one fixture per telemetry identity");
  return { authority: value.authority, id: value.id, engine: expected.engine, path: expected.path };
}
async function fixtureActor(page: Page, engine: Engine, path: string): Promise<Actor> {
  const observations: unknown = await page.evaluate(() => {
    const getter: unknown = Reflect.get(globalThis, "__bunMemoryVerifierActors");
    if (typeof getter !== "function") throw new Error("Missing host launch observer");
    return getter();
  });
  return selectActor(observations, { engine, path });
}
export function actorSnapshot(value: Sample, actor: Actor) {
  assert(actor.engine === "quickjs" || actor.engine === "jsc", "only QJS/JSC heap assertions are implemented");
  assert.equal(actor.authority, "host-worker-launch");
  assert.equal(value.rawProcesses.filter(raw => raw && typeof raw === "object" && Reflect.get(raw, "id") === actor.id).length, 1, "unique raw actor required");
  const matches = value.processes.filter(process => process.id === actor.id);
  assert.equal(matches.length, 1, `missing or invalid fixture actor ${actor.path}`);
  const process = matches[0]!;
  assert.equal(process.engine, actor.engine, "raw actor engine must match launch");
  return process;
}
function sequence(value: Sample, actor: Actor): number {
  const counters: unknown = Reflect.get(actorSnapshot(value, actor), "engineCounters");
  assert(counters && typeof counters === "object", "engine counters required for the selected actor");
  const sequence: unknown = Reflect.get(counters, "refreshSequence");
  assert(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0, "known refresh sequence required");
  return sequence;
}
function exactFailure(value: Sample, actor: Actor): void {
  const failure = { bytes: failedBytes, category: actor.engine === "quickjs" ? "quickjs.arrayBuffer" : "jsc.typedArray" };
  assert.deepEqual(actorSnapshot(value, actor).failedAllocation, failure, "selected actor retains exact failure");
  assert.deepEqual(value.observedFailures.filter(observation => observation.processId === actor.id), [{ processId: actor.id, engine: actor.engine, failedAllocation: failure }]);
}
function liveActor(value: Sample, actor: Actor) {
  const process = actorSnapshot(value, actor);
  assert.equal(process.terminal, false, "selected fixture actor remains live");
  assert.equal(process.failedAllocation, null, "previous command failure must not contaminate this actor");
  return process;
}
export function verifyAllocation(baseline: Sample, busy: Sample, allocated: Sample, actor: Actor): void {
  const before = liveActor(baseline, actor);
  assert(liveActor(busy, actor).allocatorLiveBytes !== null, "busy cached allocator read is available");
  const after = liveActor(allocated, actor);
  assert(after.allocatorLiveBytes !== null && before.allocatorLiveBytes !== null);
  assert(after.allocatorLiveBytes > before.allocatorLiveBytes, "allocator moves on real buffer allocation in the fixture actor");
  assert(after.allocatorPeakBytes !== null && after.allocatorPeakBytes >= after.allocatorLiveBytes);
  assert(after.jsHeapBytes !== null, "actual engine heap readout for the fixture actor");
  if (actor.engine === "quickjs") assert(after.arrayBufferBytes !== null && after.arrayBufferBytes >= 1048576);
  else assert.equal(after.arrayBufferBytes, null);
}
export function verifyFailure(allocated: Sample, failure: Sample, terminal: Sample, actor: Actor): void {
  exactFailure(failure, actor);
  assert.equal(sequence(failure, actor), sequence(allocated, actor), "failure read never refreshes the VM");
  exactFailure(terminal, actor);
  assert(actorSnapshot(terminal, actor).terminal, "failed fixture remains visible after exit");
  assert.equal(sequence(terminal, actor), sequence(failure, actor), "terminal read never refreshes the VM");
}
export function verifyChild(live: Sample, failure: Sample, terminal: Sample, parent: Actor, child: Actor): void {
  assert.notEqual(parent.id, child.id, "parent and child have distinct host launch identities");
  liveActor(live, parent);
  liveActor(live, child);
  liveActor(failure, parent);
  assert(actorSnapshot(failure, child).terminal, "failed child remains visible after exit");
  verifyFailure(live, failure, terminal, child);
  assert(actorSnapshot(terminal, parent).terminal, "known parent is terminal");
  assert(terminal.processes.every(process => process.terminal), "all retained observations are terminal");
}
function saveProgress(value: unknown): void { writeFileSync(join(output, "hook-progress.json"), JSON.stringify(value, null, 2) + "\n"); }
async function verifyEngine(browser: Browser, url: string, engine: "quickjs" | "jsc") {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(installActorObserver, { engine, executable: `${ENGINE_BIN[engine]}/bun`, paths: [producerPath, parentPath, childPath] });
    await page.goto(`${url}?engine=${engine}`);
    assert.match(await ready(page), /ready/);
    await startFixture(page, producerPath, `${gate}
      console.log('memory-baseline'); await gate('busy');
      console.log('memory-busy-start'); const until = Date.now()+5000; while(Date.now()<until) {}
      console.log('memory-busy-end'); await gate('allocate');
      globalThis.kept = new Uint8Array(${fixtureAllocationBytes}); console.log('memory-allocated'); await gate('fail');
      try { globalThis.failed = new Uint8Array(${failedBytes}); } catch(e) { console.log('memory-failure'); }
      await gate('stop'); console.log('memory-finished');`);
    await waitMarker(page, engine, "memory-baseline");
    const actor = await fixtureActor(page, engine, producerPath);
    const baseline = await sample({ page, phase: "baseline", engine });
    await writeFile(page, "/home/user/busy", "1");
    await waitMarker(page, engine, "memory-busy-start");
    const samplingStarted = Date.now();
    const busy = await sample({ page, phase: "compile:busy", engine });
    assert(Date.now() - samplingStarted < 4000, "busy-worker sampling stays on the responsive host");
    assert(liveActor(busy, actor).allocatorLiveBytes !== null, "busy cached allocator read is available");
    await waitMarker(page, engine, "memory-busy-end");
    await writeFile(page, "/home/user/allocate", "1");
    await waitMarker(page, engine, "memory-allocated");
    const allocated = await sample({ page, phase: "allocated", engine });
    saveProgress({ engine, baseline, busy, allocated });
    verifyAllocation(baseline, busy, allocated, actor);
    await writeFile(page, "/home/user/fail", "1");
    await waitMarker(page, engine, "memory-failure");
    const failure = await sample({ page, phase: "failure", engine });
    saveProgress({ engine, baseline, busy, allocated, failure });
    exactFailure(failure, actor);
    assert.equal(sequence(failure, actor), sequence(allocated, actor), "failure read never refreshes the VM");
    await writeFile(page, "/home/user/stop", "1");
    await waitMarker(page, engine, "memory-finished");
    await stopForeground(page);
    const terminal = await sample({ page, phase: "terminal", engine });
    verifyFailure(allocated, failure, terminal, actor);
    assert.deepEqual(await fixtureActor(page, engine, producerPath), actor, "fixture launch binding remains unique");
    const child = await verifyFailedChild(page, engine);
    const result = { engine, actor, baseline, busy, allocated, failure, terminal, child, errors, terminalText: await terminalText(page) };
    assert.deepEqual(errors, []);
    return result;
  } finally {
    await stopForeground(page).catch(() => {});
    await context.close();
  }
}
async function verifyFailedChild(page: Page, engine: "quickjs" | "jsc") {
  await writeFile(page, childPath, `${gate}
    console.log('memory-child-live'); await gate('child-fail');
    try { globalThis.failed = new Uint8Array(${failedBytes}); } catch(e) { console.log('memory-child-failed'); }`);
  await startFixture(page, parentPath, `${gate}
    const child = Bun.spawn([process.execPath, 'run', '/home/user/memory-child.ts'], { stdout:'inherit', stderr:'inherit' });
    console.log('memory-parent-live'); await child.exited; console.log('memory-child-ended');
    await gate('parent-stop'); console.log('memory-parent-finished');`);
  await waitMarker(page, engine, "memory-child-live");
  const parent = await fixtureActor(page, engine, parentPath);
  const child = await fixtureActor(page, engine, childPath);
  const live = await sample({ page, phase: "parent:idle", engine });
  liveActor(live, parent);
  liveActor(live, child);
  await writeFile(page, "/home/user/child-fail", "1");
  await waitMarker(page, engine, "memory-child-ended");
  const failure = await sample({ page, phase: "child:failure", engine });
  saveProgress({ engine, live, childFailure: failure });
  exactFailure(failure, child);
  liveActor(failure, parent);
  assert(actorSnapshot(failure, child).terminal, "failed child remains visible after exit");
  assert.equal(sequence(failure, child), sequence(live, child));
  await writeFile(page, "/home/user/parent-stop", "1");
  await waitMarker(page, engine, "memory-parent-finished");
  await stopForeground(page);
  const terminal = await sample({ page, phase: "parent:terminal", engine });
  verifyChild(live, failure, terminal, parent, child);
  assert.deepEqual(await fixtureActor(page, engine, parentPath), parent);
  assert.deepEqual(await fixtureActor(page, engine, childPath), child);
  return { actors: { parent, child }, live, failure, terminal };
}

if (import.meta.main) await main();
