import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import type { Page } from "playwright";
import { playwright, ready, run, session, terminalText, writeFile } from "../../web/tests/playground.mjs";
import { stopShell } from "../../web/tests/stop-shell";
import { resetBrowserProject } from "./browser-environment";
import { observeProductTraffic, waitForPreviewReady, type GuestSource } from "./product-browser";
import { registry } from "./registry.mjs";
import { readGuest } from "./browser.mjs";
import { browserRegistryRoute } from "./registry-request";
import { editCycle, compileErrorRecovery } from "./next-acceptance-edits";
import { routeCases, runRouteCase, overlappingRequests } from "./next-acceptance-cases";
import { emptyMemory, memoryGate, parseMemory, resultTable, type AcceptanceEngine, type MemorySample, type Outcome, type PhaseResult } from "./next-acceptance-model";

const { values } = parseArgs({ options: {
  engine: { type: "string" }, "web-root": { type: "string" }, output: { type: "string" },
  "runtime-revision": { type: "string" }, "runtime-receipt": { type: "string" },
  registry: { type: "string" }, "memory-hook": { type: "string" },
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
const rows: PhaseResult[] = [];
const samples: MemorySample[] = [];
const external: string[] = [];
let observedEngine = "not loaded";
let completedCycles = 0;
let droppedSamples = 0;
let browserVersion = "not launched";
let owner: Page | undefined;
let assets: Record<string, string> = {};
let cleanup = "pending";
const samplerErrors: string[] = [];
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
mkdirSync(output, { recursive: true });
// A report directory is a single run, so stale evidence cannot turn a later run green.
writeFileSync(join(output, "run.json"), "", { flag: "wx" });
const task = session("next01-");
let mirror: Awaited<ReturnType<typeof registry>> | undefined;
let hook: ((input: { page: Page; phase: string; engine: AcceptanceEngine }) => Promise<unknown>) | undefined;

function fixtureSources(directory: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".gitignore", "next-env.d.ts"].includes(entry.name) || entry.name.endsWith("tsbuildinfo")) continue;
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, fixtureSources(join(directory, entry.name), path + "/"));
    else files[path] = readFileSync(join(directory, entry.name), "utf8");
  }
  return files;
}

function save() {
  const report = {
    schema: 1, engine, observedEngine, browser: { name: "chromium", version: browserVersion },
    fixture: { path: "examples/next-acceptance", sourceRevision, sha256: digest(JSON.stringify(sources)), lockSha256: digest(sources["bun.lock"] ?? ""), dependencies: JSON.parse(sources["package.json"] ?? "{}").dependencies },
    runtime: { revision: values["runtime-revision"], revisionSource: "caller supplied; compare to producer receipt", assets, receipt: values["runtime-receipt"] ? resolve(values["runtime-receipt"]) : null },
    parameters: { cycles, timeoutMs: timeout, idleMs: idle, minHeadroomMiB: minHeadroom, maxGrowthMiB: maxGrowth, phases: Array.from(phases) },
    completedCycles, droppedSamples, samplerErrors, rows, samples,
    network: { mode: mirror ? "registry replay" : "live npm (diagnostic)", external, mirror: mirror?.snapshot() }, cleanup,
    acceptance: rows.length > 0 && rows.every(row => row.status === "pass") && cleanup === "pass",
  };
  writeFileSync(join(output, "run.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(output, "results.md"), resultTable(rows));
}

async function sample(phase: string) {
  if (!owner) return;
  const counters = hook ? parseMemory(await hook({ page: owner, phase, engine })) : emptyMemory;
  if (samples.length >= 8192) { droppedSamples++; return; }
  samples.push({ ...counters, phase, engine, time: Date.now() });
}

async function measured(operation: () => Promise<void>, phase: string) {
  let pending = Promise.resolve();
  const tick = () => { pending = pending.then(() => sample(phase)).catch(error => { samplerErrors.push(String(error)); }); };
  tick();
  const timer = setInterval(tick, 500);
  try { await operation(); }
  finally { clearInterval(timer); await pending; }
}

async function phase(name: string, operation: () => Promise<void>, prerequisite?: string): Promise<boolean> {
  const previous = prerequisite ? rows.find(row => row.phase === prerequisite) : undefined;
  if (prerequisite && previous?.status !== "pass") return record(name, { status: "blocked", reason: `Requires ${prerequisite}: ${previous?.status ?? "missing"}` });
  const started = performance.now();
  try {
    await measured(operation, name);
    return record(name, { status: "pass", detail: "Assertions passed" }, started);
  } catch (error) { return record(name, { status: "fail", reason: String(error) }, started); }
}

function record(name: string, outcome: Outcome, started = performance.now()): boolean {
  const row = { phase: name, engine, observedEngine, durationMs: Math.round(performance.now() - started), ...outcome };
  rows.push(row);
  save();
  process.stdout.write(`${engine} ${name}: ${row.status}\n`);
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
  const traffic = await observeProductTraffic(preview);
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

async function serverCases(owner: Page, page: Page, base: string, mode: "start" | "dev", source: GuestSource, traffic: Awaited<ReturnType<typeof observeProductTraffic>>) {
  await phase(`${mode}:http-ready`, async () => {
    const probe = await page.context().newPage();
    try { await waitForPreviewReady(probe, base, Date.now() + timeout); }
    finally { await probe.close(); }
  }, mode);
  for (const name of routeCases) await phase(`${mode}:${name}`, async () => { await alive(owner); await runRouteCase(name, page, base); await alive(owner); }, `${mode}:http-ready`);
  if (mode !== "dev") return;
  const warmed = routeCases.every(name => rows.find(row => row.phase === `dev:${name}`)?.status === "pass");
  record("dev:warm", warmed ? { status: "pass", detail: "Every route compiled and checked" } : { status: "blocked", reason: "Warm-up requires all route probes" });
  await phase("dev:warm-memory", async () => { await page.waitForTimeout(idle); await sample("warm:idle"); }, "dev:warm");
  await phase("dev:edits", async () => {
    for (let index = 0; index < cycles; index++) await cycle(owner, page, base, source, traffic, index);
    assert.ok(completedCycles >= 30, `${completedCycles}/30 cycles; smoke run cannot pass`);
  }, "dev:warm");
  await phase("dev:compile-recovery", () => compileErrorRecovery(page, base, source), "dev:warm");
  await phase("dev:application-recovery", () => runRouteCase("application-error", page, base), "dev:warm");
  await phase("dev:overlap-after-errors", () => overlappingRequests(page, base, "after-errors"), "dev:compile-recovery");
  await phase("dev:navigation", async () => {
    await page.goto(new URL("dynamic", base).href);
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await page.getByRole("heading", { name: "NEXT-01 static", exact: true }).waitFor();
    await alive(owner);
  }, "dev:compile-recovery");
  record("dev:bounded-memory", samplerErrors.length || droppedSamples ? { status: "blocked", reason: `Sampler errors ${samplerErrors.length}; dropped ${droppedSamples}` } : memoryGate(samples, completedCycles, minHeadroom, maxGrowth));
}

async function cycle(owner: Page, page: Page, base: string, source: GuestSource, traffic: Awaited<ReturnType<typeof observeProductTraffic>>, index: number) {
  const passed = await phase(`dev:cycle:${index}`, async () => {
    await alive(owner);
    await sample(`cycle:${index}:before`);
    await editCycle(page, base, source, traffic, index, timeout, sample);
    await overlappingRequests(page, base, `hmr-${index}`);
    await page.waitForTimeout(idle);
    await sample(`cycle:${index}:idle`);
    await alive(owner);
  });
  if (!passed) throw new Error(`Edit/revert cycle ${index} failed; retained ${completedCycles} complete cycles`);
  completedCycles++;
}

function verifyAssets() {
  const manifest: unknown = JSON.parse(readFileSync(join(webRoot, "engine-builds.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object");
  const core = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm", browser: "bun-browser.wasm" }[engine];
  const side = engine === "quickjs" ? ["quickjs.wasm"] : engine === "jsc" ? ["jsc-engine.wasm"] : [];
  for (const name of [core].concat(side)) {
    const raw = join(webRoot, name);
    const bytes = existsSync(raw) ? readFileSync(raw) : gunzipSync(readFileSync(raw + ".gz"));
    const hash = digest(bytes);
    assert.equal(Reflect.get(manifest, name), hash, `${name} served bytes match manifest`);
    assets[name] = hash;
  }
  if (!values["runtime-receipt"]) return;
  const receipt: unknown = JSON.parse(readFileSync(values["runtime-receipt"], "utf8"));
  assert.ok(receipt && typeof receipt === "object");
  assert.equal(Reflect.get(receipt, "artifactSha256"), assets[core], "Producer receipt matches executed core");
  writeFileSync(join(output, "runtime-receipt.json"), JSON.stringify(receipt, null, 2));
}

async function main() {
  if (!await phase("assets", async () => { verifyAssets(); })) return;
  if (values["memory-hook"]) {
    const module: unknown = await import(pathToFileURL(resolve(values["memory-hook"])).href);
    assert.ok(module && typeof module === "object" && "sample" in module && typeof module.sample === "function");
    const fn = module.sample;
    hook = async input => fn(input);
  }
  if (values.registry) mirror = await registry({ directory: resolve(values.registry), record: false });
  const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: webRoot, PORT: "0" });
  const browser = await task.launch(playwright.chromium);
  browserVersion = browser.version();
  const context = await browser.newContext({ serviceWorkers: "allow" });
  if (mirror) await context.route("**/*", route => browserRegistryRoute(route, mirror!.base, external));
  owner = await context.newPage();
  const page = owner;
  const loaded = await phase("engine", async () => {
    await page.goto(`${match[1]}?engine=${engine}`);
    observedEngine = await ready(page, timeout);
    const label = { quickjs: "QuickJS", jsc: "JavaScriptCore", browser: "Browser" }[engine];
    assert.ok(observedEngine.includes("ready") && observedEngine.includes(label), `Wrong engine: ${observedEngine}`);
    assert.equal(await page.locator("#engine").inputValue(), engine);
    await page.evaluate(resetBrowserProject);
    for (const [path, text] of Object.entries(sources)) await writeFile(page, `/home/user/${path}`, text);
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
  if (owner && !owner.isClosed()) await terminalText(owner).then(text => writeFileSync(join(output, "terminal.log"), text)).catch(error => samplerErrors.push(String(error)));
  try { await task.cleanup(); await mirror?.close(); cleanup = "pass"; }
  catch (error) { cleanup = String(error); }
  save();
}
if (rows.some(row => row.status !== "pass") || cleanup !== "pass") process.exitCode = 1;
