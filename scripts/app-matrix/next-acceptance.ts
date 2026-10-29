import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page, BrowserServer } from "playwright";
import { playwright, ready, run, session, terminalText, writeFile } from "../../web/tests/playground.mjs";
import { stopShell } from "../../web/tests/stop-shell";
import { resetBrowserProject } from "./browser-environment";
import { observeNativeProductTraffic, waitForPreviewReady, type GuestSource } from "./product-browser";
import { registry } from "./registry.mjs";
import { nextRegistry } from "../../web/tests/next-framework-registry";
import { readGuest } from "./browser.mjs";
import { browserRegistryRoute } from "./registry-request";
import { editCycle, compileErrorRecovery } from "./next-acceptance-edits";
import { closeOwnedBrowser, boundedCleanup } from "./cleanup";
import { requestProbe } from "./next-acceptance-http";
import { runAcceptancePhase } from "./next-acceptance-phase";
import { routeCases, runRouteCase, overlappingRequests } from "./next-acceptance-cases";
import { fixtureSources, stageFixture } from "./next-acceptance-fixture";
import { verifyAcceptanceAssets } from "./next-acceptance-assets";
import { emptyMemory, memoryGate, parseMemory, resultTable, type AcceptanceEngine, type MemorySample, type Outcome, type PhaseResult } from "./next-acceptance-model";

const { values } = parseArgs({ options: {
  engine: { type: "string" }, "web-root": { type: "string" }, output: { type: "string" },
  "runtime-revision": { type: "string" }, "runtime-receipt": { type: "string" },
  registry: { type: "string" }, "registry-extra": { type: "string" }, "memory-hook": { type: "string" },
  port: { type: "string", default: "43701" }, cycles: { type: "string", default: "30" },
  phases: { type: "string", default: "install,build,start,dev" },
  "timeout-ms": { type: "string", default: "180000" }, "idle-ms": { type: "string", default: "1500" },
  "min-headroom-mib": { type: "string", default: "32" }, "max-growth-mib": { type: "string", default: "16" },
} });
if (values.engine !== "quickjs" && values.engine !== "jsc" && values.engine !== "browser") throw new Error("--engine quickjs|jsc|browser is required");
if (!values["web-root"] || !values.output || !/^[a-f0-9]{40}$/.test(values["runtime-revision"] ?? "")) throw new Error("--web-root, --output and --runtime-revision <full SHA> are required");
const engine: AcceptanceEngine = values.engine;
const webRoot = resolve(values["web-root"]);
const output = resolve(values.output);
const fixture = resolve(import.meta.dir, "../../examples/next-acceptance");
const phases = new Set(values.phases?.split(","));
for (const phase of phases) if (!["install", "build", "start", "dev"].includes(phase)) throw new Error(`Unknown phase ${phase}`);
const numeric = (name: keyof typeof values, minimum: number, maximum: number) => {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid --${name}`);
  return value;
};
const cycles = numeric("cycles", 0, 1000);
const timeout = numeric("timeout-ms", 1000, 900000);
const idle = numeric("idle-ms", 1000, 60000);
const port = numeric("port", 1024, 65535);
const minHeadroom = numeric("min-headroom-mib", 1, 4096);
const maxGrowth = numeric("max-growth-mib", 0, 4096);
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const sources = fixtureSources(fixture);
const staged = stageFixture(sources);
const rows: PhaseResult[] = [];
const samples: MemorySample[] = [];
const external: string[] = [];
const rebuilds: Awaited<ReturnType<typeof editCycle>>[] = [];
let observedEngine = "not loaded";
let completedCycles = 0;
let devProcessId: number | null = null;
let droppedSamples = 0;
let browserVersion = "not launched";
let owner: Page | undefined;
let browserServer: BrowserServer | undefined;
let samplingStopped = false;
let assets: Record<string, string> = {};
let cleanup = "pending";
const failedAllocations: { bytes: number | null; category: string; evidence: string }[] = [];
const samplerErrors: string[] = [];
let samplerBusy = false;
let lastSample: Promise<void> = Promise.resolve();
let samplingPhase = "startup";
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
mkdirSync(output, { recursive: true });
// A report directory is a single run, so stale evidence cannot turn a later run green.
writeFileSync(join(output, "run.json"), "", { flag: "wx" });
process.env.BUN_WASM_TEST_TMP ??= "/work/tmp";
const task = session("bun-wasm-next01-");
process.env.TMPDIR = task.scratch;
let mirror: Awaited<ReturnType<typeof registry>> | undefined;
let hook: ((input: { page: Page; phase: string; engine: AcceptanceEngine }) => Promise<unknown>) | undefined;

function save() {
  const report = {
    schema: 1, engine, observedEngine, browser: { name: "chromium", version: browserVersion },
    fixture: { path: "examples/next-acceptance", sourceRevision, sha256: digest(JSON.stringify(sources)), lockSha256: digest(sources["bun.lock"] ?? ""), stagedSha256: digest(JSON.stringify(staged.files)), config: staged.config, dependencies: JSON.parse(sources["package.json"] ?? "{}").dependencies },
    runtime: { revision: values["runtime-revision"], revisionSource: "caller supplied; compare to producer receipt", assets, webRoot, receipt: values["runtime-receipt"] ? resolve(values["runtime-receipt"]) : null },
    parameters: { cycles, timeoutMs: timeout, idleMs: idle, minHeadroomMiB: minHeadroom, maxGrowthMiB: maxGrowth, phases: Array.from(phases) },
    completedCycles, devProcessId, droppedSamples, samplerErrors, failedAllocations, rebuilds, rows, samples,
    network: { mode: mirror ? "registry replay" : "live npm (diagnostic)", external, mirror: mirror?.snapshot() }, cleanup,
    acceptance: rows.length > 0 && rows.every(row => row.status === "pass") && cleanup === "pass" && !samplerErrors.length && !droppedSamples,
  };
  writeFileSync(join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(output, "results.md"), resultTable(rows));
}

async function sample(phase: string) {
  if (!owner || samplingStopped) return;
  const counters = hook ? parseMemory(await boundedSample(hook({ page: owner, phase, engine }))) : emptyMemory;
  if (samples.length >= 8192) { droppedSamples++; return; }
  samples.push({ ...counters, phase, engine, time: Date.now() });
}

async function boundarySample(phase: string) {
  await lastSample;
  samplerBusy = true;
  try { await sample(phase); }
  finally { samplerBusy = false; }
}

async function boundedSample(operation: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(stopSampling, 5000, reject); })]);
  } finally { clearTimeout(timer); }
}

function stopSampling(reject: (error: Error) => void) {
  samplingStopped = true;
  reject(new Error("Memory hook exceeded 5s; further sampling stopped"));
}

async function measured(operation: () => Promise<void>, phase: string) {
  const previous = samplingPhase;
  samplingPhase = phase;
  const tick = () => {
    if (samplerBusy || samplingPhase !== phase) return;
    samplerBusy = true;
    lastSample = sample(phase).catch(recordSamplerError).finally(() => { samplerBusy = false; });
  };
  tick();
  const timer = setInterval(tick, 500);
  try { await operation(); }
  finally { clearInterval(timer); await lastSample; samplingPhase = previous; }
}

function recordSamplerError(error: unknown) {
  if (samplerErrors.length < 64) samplerErrors.push(String(error));
}

async function cancelPhase() {
  if (browserServer) await closeOwnedBrowser(browserServer, 1000);
}

async function phase(name: string, operation: () => Promise<void>, prerequisite?: string, budgetMs = timeout + 5000): Promise<boolean> {
  const previous = prerequisite ? rows.find(row => row.phase === prerequisite) : undefined;
  if (prerequisite && previous?.status !== "pass") return record(name, { status: "blocked", reason: `Requires ${prerequisite}: ${previous?.status ?? "missing"}` });
  const result = await runAcceptancePhase({ phase: name, engine, observedEngine, timeoutMs: budgetMs,
    operation: () => measured(operation, name), cancel: cancelPhase, record: row => persistResult({ ...row, observedEngine }) });
  return result.status === "pass";
}

function persistResult(row: PhaseResult) {
  rows.push(row);
  save();
  process.stdout.write(`${engine} ${row.phase}: ${row.status}\n`);
}

function record(name: string, outcome: Outcome, started = performance.now()): boolean {
  const row = { phase: name, engine, observedEngine, durationMs: Math.round(performance.now() - started), ...outcome };
  persistResult(row);
  return row.status === "pass";
}

function selected(name: string) {
  if (phases.has(name)) return true;
  record(name, { status: "blocked", reason: "Not requested in this diagnostic run" });
  return false;
}

async function command(page: Page, name: string, text: string) {
  const result = await run(page, text, timeout);
  writeFileSync(join(output, `${name}.log`), result.output);
  assert.equal(result.code, 0, `${text}: ${result.output}`);
}

async function verifyInstall(page: Page) {
  await command(page, "install", "bun install --frozen-lockfile");
  const metadata: unknown = JSON.parse(sources["package.json"] ?? "{}");
  assert.ok(metadata && typeof metadata === "object" && "dependencies" in metadata && metadata.dependencies && typeof metadata.dependencies === "object");
  for (const [name, version] of Object.entries(metadata.dependencies)) {
    const text = await readGuest(page, `node_modules/${name}/package.json`);
    assert.ok(text, `Installed ${name}`);
    assert.equal(JSON.parse(text).version, version, `${name} locked version`);
  }
}


async function alive(page: Page) {
  const state = await page.evaluate(() => ({ running: Reflect.get(Reflect.get(globalThis, "playground"), "shell").running, done: Reflect.get(globalThis, "__nextAcceptanceDone") }));
  assert.ok(state.running && !state.done, "The same dev server command must remain alive");
}

async function startServer(page: Page, mode: "start" | "dev") {
  const text = `bun run launch.ts ${mode}${mode === "dev" ? " --webpack" : ""} --hostname 127.0.0.1 --port ${port}`;
  await page.evaluate(text => {
    Reflect.set(globalThis, "__nextAcceptanceDone", false);
    const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell");
    Reflect.set(globalThis, "__nextAcceptanceCommand", shell.submit(text).finally(() => { Reflect.set(globalThis, "__nextAcceptanceDone", true); }));
  }, text);
  await page.waitForFunction(port => Reflect.get(Reflect.get(globalThis, "playground"), "previews").serves(port) || Reflect.get(globalThis, "__nextAcceptanceDone"), port, { timeout });
  await alive(page);
}

async function server(page: Page, mode: "start" | "dev") {
  const started = await phase(mode, () => startServer(page, mode), mode === "start" ? "build" : "install");
  const preview = await page.context().newPage();
  preview.setDefaultTimeout(timeout);
  preview.setDefaultNavigationTimeout(timeout);
  const traffic = await observeNativeProductTraffic(preview);
  const source: GuestSource = { read: path => readGuest(page, path), write: (path, text) => writeFile(page, `/home/user/${path}`, text) };
  const base = started ? await page.evaluate(port => Reflect.get(Reflect.get(globalThis, "playground"), "previews").url(port), port) : "http://127.0.0.1/";
  try { await serverCases(page, preview, base, mode, source, traffic); }
  finally {
    await traffic.close();
    await preview.close();
    await phase(`${mode}:stop`, () => stopServer(page, mode));
  }
}

async function stopServer(page: Page, mode: string) {
  if (await page.evaluate(() => Reflect.get(Reflect.get(globalThis, "playground"), "shell").running)) await stopShell(page);
  await page.evaluate(async () => { await Reflect.get(globalThis, "__nextAcceptanceCommand"); });
  assert.equal(await page.evaluate(port => Reflect.get(Reflect.get(globalThis, "playground"), "previews").serves(port), port), false, "Server listener released");
  writeFileSync(join(output, `${mode}.log`), await terminalText(page));
}

async function serverCases(owner: Page, page: Page, base: string, mode: "start" | "dev", source: GuestSource, traffic: Awaited<ReturnType<typeof observeNativeProductTraffic>>) {
  await phase(`${mode}:http-ready`, async () => {
    const probe = await page.context().newPage();
    try { await waitForPreviewReady(probe, base, Date.now() + timeout, 1000); }
    finally { await probe.close(); }
  }, mode);
  for (const name of routeCases) await phase(`${mode}:${name}`, async () => { await alive(owner); await runRouteCase(name, page, base, timeout); await alive(owner); }, `${mode}:http-ready`);
  if (mode !== "dev") return;
  const warmed = routeCases.every(name => rows.find(row => row.phase === `dev:${name}`)?.status === "pass");
  record("dev:warm", warmed ? { status: "pass", detail: "Every route compiled and checked" } : { status: "blocked", reason: "Warm-up requires all route probes" });
  await phase("dev:process", async () => { devProcessId = await serverPid(page, base); }, "dev:warm");
  await phase("dev:warm-memory", async () => { await page.waitForTimeout(idle); await boundarySample("warm:idle"); }, "dev:warm");
  await phase("dev:edits", async () => {
    for (let index = 0; index < cycles; index++) await cycle(owner, page, base, source, traffic, index);
    assert.ok(completedCycles >= 30, `${completedCycles}/30 cycles; smoke run cannot pass`);
  }, "dev:process", Math.max(1, cycles) * (timeout * 3 + idle + 5000));
  await phase("dev:compile-recovery", () => compileErrorRecovery(page, base, source, timeout), "dev:warm");
  await phase("dev:application-recovery", () => runRouteCase("application-error", page, base, timeout), "dev:warm");
  await phase("dev:overlap-after-errors", () => overlappingRequests(page, base, "after-errors", timeout), "dev:compile-recovery");
  await phase("dev:navigation", async () => {
    await page.goto(new URL("dynamic", base).href);
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("heading", { name: "NEXT-01 static", exact: true }).waitFor();
    await alive(owner);
  }, "dev:compile-recovery");
  record("dev:bounded-memory", samplerErrors.length || droppedSamples ? { status: "blocked", reason: `Sampler errors ${samplerErrors.length}; dropped ${droppedSamples}` } : memoryGate(samples, completedCycles, minHeadroom, maxGrowth));
}

async function serverPid(page: Page, base: string): Promise<number> {
  const response = await requestProbe(page, { url: new URL("api/context", base).href, deadline: Date.now() + timeout });
  const observed: unknown = JSON.parse(response.body);
  assert.ok(observed && typeof observed === "object" && "pid" in observed && typeof observed.pid === "number" && Number.isSafeInteger(observed.pid) && observed.pid > 0, "Next response must identify the serving process");
  return observed.pid;
}

async function cycle(owner: Page, page: Page, base: string, source: GuestSource, traffic: Awaited<ReturnType<typeof observeNativeProductTraffic>>, index: number) {
  const passed = await phase(`dev:cycle:${index}`, async () => {
    await alive(owner);
    assert.equal(await serverPid(page, base), devProcessId, "Same warmed Next process before edit");
    await boundarySample(`cycle:${index}:before`);
    rebuilds.push(await editCycle(page, base, source, traffic, index, timeout, boundarySample));
    await overlappingRequests(page, base, `hmr-${index}`, timeout);
    await page.waitForTimeout(idle);
    await boundarySample(`cycle:${index}:idle`);
    assert.equal(await serverPid(page, base), devProcessId, "Same warmed Next process after edit/revert");
    await alive(owner);
  });
  if (!passed) throw new Error(`Edit/revert cycle ${index} failed; retained ${completedCycles} complete cycles`);
  completedCycles++;
}

async function main() {
  if (!await phase("assets", async () => {
    assets = await verifyAcceptanceAssets({ root: webRoot, engine, revision: values["runtime-revision"] ?? "", receipt: values["runtime-receipt"], scratch: task.scratch });
    if (values["runtime-receipt"]) writeFileSync(join(output, "runtime-receipt.json"), readFileSync(values["runtime-receipt"]));
  })) return;
  record("provenance", values["runtime-receipt"] ? { status: "pass", detail: "Canonical core, companion, source manifest and source revision verified" } : { status: "blocked", reason: "No canonical runtime receipt; historical/diagnostic bytes only" });
  if (values["memory-hook"]) {
    const module: unknown = await import(pathToFileURL(resolve(values["memory-hook"])).href);
    assert.ok(module && typeof module === "object" && "sample" in module && typeof module.sample === "function");
    const fn = module.sample;
    hook = async input => fn(input);
  }
  if (values.registry && values["registry-extra"]) throw new Error("Choose --registry or --registry-extra");
  if (values.registry) mirror = await registry({ directory: resolve(values.registry), record: false });
  if (values["registry-extra"]) {
    const replay = nextRegistry(resolve(values["registry-extra"]), 0);
    const indexes = ["/work/cache/bun-wasm-app-matrix/index.json", join(resolve(values["registry-extra"]), "index.json")].map(path => readFileSync(path, "utf8"));
    const registryHash = digest(indexes.join("\n"));
    const entries = new Set(indexes.flatMap(text => Object.keys(JSON.parse(text)))).size;
    mirror = { ...replay, errors: [], snapshot: () => ({ entries, sha256: registryHash, requests: replay.requests.length, misses: replay.misses, errors: [] }) };
  }
  const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: webRoot, PORT: "0", PREVIEW_ORIGINS: "1" });
  const browser = await task.launch({ launch: async () => {
    browserServer = await playwright.chromium.launchServer();
    return playwright.chromium.connect(browserServer.wsEndpoint());
  } });
  browserVersion = browser.version();
  const context = await browser.newContext({ serviceWorkers: "allow" });
  if (mirror) await context.route("**/*", route => browserRegistryRoute(route, mirror!.base, external));
  owner = await context.newPage();
  const page = owner;
  const loaded = await phase("engine", async () => {
    await page.goto(`${match[1]}?root-previews&engine=${engine}`);
    observedEngine = (await ready(page, timeout)).replaceAll(" MB", " MiB");
    const label = { quickjs: "QuickJS", jsc: "JavaScriptCore", browser: "Browser" }[engine];
    assert.ok(observedEngine.includes("ready") && observedEngine.includes(label), `Wrong engine: ${observedEngine}`);
    assert.equal(await page.locator("#engine").inputValue(), engine);
    await page.evaluate(resetBrowserProject);
    for (const [path, text] of Object.entries(staged.files)) await writeFile(page, `/home/user/${path}`, text);
    if (mirror) await writeFile(page, "/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(mirror.base)}\n`);
    await sample("startup");
  });
  if (!loaded) return;
  if (selected("install")) await phase("install", () => verifyInstall(page), "engine");
  if (selected("build")) await phase("build", async () => {
    await command(page, "build", "bun run launch.ts build --webpack");
    assert.ok(await readGuest(page, ".next/BUILD_ID"), "A zero exit requires BUILD_ID");
  }, "install");
  if (selected("start")) await server(page, "start");
  if (selected("dev")) await server(page, "dev");
  await phase("network", async () => { assert.deepEqual(external, []); if (mirror) { assert.deepEqual(mirror.misses, []); assert.deepEqual(mirror.errors, []); } });
}

try { await main(); }
catch (error) { record("runner", { status: "fail", reason: String(error) }); }
finally {
  if (owner && !owner.isClosed()) await boundedCleanup("terminal-capture", () => terminalText(owner!).then(text => {
    writeFileSync(join(output, "terminal.log"), text);
    for (const match of text.matchAll(/memory allocation of (\d+) bytes failed/g)) failedAllocations.push({ bytes: Number(match[1]), category: "allocator; attribution unavailable", evidence: match[0] });
    if (/MemoryExhaustion|out of memory|OOM/i.test(text) && !failedAllocations.length) failedAllocations.push({ bytes: null, category: "unattributed memory failure", evidence: "See terminal.log" });
  }), 2000).then(failure => { if (failure) recordSamplerError(failure.error); });
  const released = await Promise.allSettled([
    browserServer && closeOwnedBrowser(browserServer, 1000),
    boundedCleanup("session", () => task.cleanup(), 5000).then(failure => { if (failure) throw new Error(failure.error); }),
    boundedCleanup("registry", () => mirror?.close(), 2000).then(failure => { if (failure) throw new Error(failure.error); }),
  ]);
  cleanup = released.every(result => result.status === "fulfilled") ? "pass" : released.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []).join("; ");
  save();
}
if (rows.some(row => row.status !== "pass") || cleanup !== "pass" || samplerErrors.length || droppedSamples) process.exitCode = 1;
