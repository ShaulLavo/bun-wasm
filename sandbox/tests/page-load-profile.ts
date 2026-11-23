// Page-load waterfalls for the playground (web/dist) and the sandbox (sandbox/dist) in
// Playwright Chromium and Firefox. Each run starts a fresh browser profile (cold), then
// relaunches the browser on the same profile (warm: HTTP cache, CacheStorage and the stored
// workspace survive). Every time is milliseconds since navigation start, read from the page's
// own `bunwasm:*` marks and measures and its resource timing.
//
//   bun sandbox/tests/page-load-profile.ts --out /work/tmp/bun-wasm-page-load \
//     [--browsers chromium,firefox] [--targets web:browser,web:quickjs,sandbox:browser] [--runs 1] \
//     [--template vite-react] \
//     [--variant before=<web dist>,<sandbox dist> --variant after=<web dist>,<sandbox dist>]
//
// It also counts each page worker's IndexedDB reads and SHA-256 digests per boot stage
// (`installStorageReadCounter`), which shows where a reopened workspace reads stored files.
//
// Build web/dist and sandbox/dist first. Variants run interleaved, so host load affects each
// alike. Results: <out>/<run>.json and <out>/SUMMARY.md, with per-stage medians.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, firefox, type BrowserContext, type BrowserType, type Page, type Worker as PlaywrightWorker } from "playwright";
import { ChildGroup, ContextGroup, installPageLoadObserver, installStorageReadCounter, onInterrupt, requireUniqueNames, runAll, type PageLoadState, type StorageRead } from "./page-load-support";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1]! : fallback;
const repo = resolve(import.meta.dir, "../..");
const out = resolve(option("out", "/work/tmp/bun-wasm-page-load"));
const browsers = option("browsers", "chromium,firefox").split(",");
const targets = option("targets", "web:browser,web:quickjs,web:jsc,sandbox:browser").split(",").map(parseTarget);
const runs = Number(option("runs", "1"));
const timeout = Number(option("timeout", "300000"));
const template = args.includes("--template") ? option("template", "") : undefined;
const variants = args.flatMap((arg, index) => arg === "--variant" ? [parseVariant(args[index + 1] ?? "")] : []);
if (!variants.length) variants.push({ name: "", roots: { web: join(repo, "web/dist"), sandbox: join(repo, "sandbox/dist") } });
requireUniqueNames(variants.map(variant => variant.name));
const types: Record<string, BrowserType> = { chromium, firefox };

type App = "web" | "sandbox";
interface Target { app: App; engine: string }
interface Variant { name: string; roots: Record<App, string> }
interface Entry { name: string; type: string; start: number; end: number; detail?: unknown }
interface Resource { name: string; start: number; end: number; transfer: number; encoded: number; decoded: number }
interface Visit { run: string; ready: number | null; error: string | null; entries: Entry[]; resources: Resource[]; navigation: Record<string, number>; storage: StoragePhase[] }
/** IndexedDB reads and digests between two consecutive stages, from every worker of the page. */
interface StoragePhase { phase: string; until: number; reads: number; bytes: number; readMs: number; digests: number; digestMs: number; files: Record<number, number> }

const columns: Record<App, string[]> = {
  web: ["domContentLoaded", "filesystem-open", "workspace-ready", "module-scope-ready", "engine-ready", "programs-ready", "bun-registered", "shell-created", "ready"],
  sandbox: ["domContentLoaded", "storage-prepared", "filesystem-open", "workspace-ready", "engine-ready", "editor-open", "module-scope-ready", "programs-ready", "install-start", "install-done", "dev-start", "dev-server", "ready"],
};

function parseTarget(text: string): Target {
  const [app, engine] = text.split(":");
  if ((app !== "web" && app !== "sandbox") || !engine) throw new Error(`Bad target ${text}; use web:<engine> or sandbox:<engine>`);
  return { app, engine };
}

function parseVariant(text: string): Variant {
  const [name, roots] = text.split("=");
  const [web, sandbox] = roots?.split(",") ?? [];
  if (!name || !web || !sandbox) throw new Error(`Bad variant ${text}; use <name>=<web dist>,<sandbox dist>`);
  return { name, roots: { web: resolve(web), sandbox: resolve(sandbox) } };
}

await mkdir(out, { recursive: true });
const servers = new Map<string, string>();
const children = new ChildGroup();
const contexts = new ContextGroup<BrowserContext>();
// Browser profiles stay off /work: its VDO volume makes Firefox's IndexedDB and CacheStorage
// fsyncs 50-100x slower than an ordinary SSD (a cold indexedDB.open takes 9 s instead of 90 ms).
const profiles = await mkdtemp(join(option("profiles", tmpdir()), "bun-wasm-page-load-"));
let teardown: Promise<void> | undefined;
const cleanup = () => teardown ??= runAll([
  () => contexts.closeAll(),
  () => children.stop(),
  () => rm(profiles, { recursive: true, force: true }),
]);
onInterrupt(cleanup);
const visits: Visit[] = [];
try {
  for (const { variant, app } of variants.flatMap(variant => Array.from(new Set(targets.map(target => target.app)), app => ({ variant, app })))) {
    servers.set(`${variant.name}:${app}`, await serve(variant.roots[app]));
  }
  for (const { attempt, browser, target, variant } of plan()) visits.push(...await profile(browser, target, variant, attempt));
} finally {
  await cleanup();
}
await writeFile(join(out, "SUMMARY.md"), summary(visits));
console.log(summary(visits));

/** Variants alternate innermost, so neighbouring before/after visits share host conditions. */
function plan(): { attempt: number; browser: string; target: Target; variant: Variant }[] {
  const attempts = Array.from({ length: runs }, (_, index) => index + 1);
  return attempts.flatMap(attempt => browsers.flatMap(browser => targets.flatMap(target => variants.map(variant => ({ attempt, browser, target, variant })))));
}

async function serve(root: string): Promise<string> {
  const child = children.spawn("bun", [join(repo, "web/serve.ts")], { env: { ...process.env, ROOT: root, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  const url = await new Promise<string>((resolveUrl, reject) => {
    let output = "";
    child.once("exit", code => reject(new Error(`serve.ts exited ${code}`)));
    child.once("error", reject);
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = / at (http:\/\/\S+?)\/? \(/.exec(output);
      if (match) resolveUrl(match[1]!);
    });
  });
  // The first request pays for the server's own startup; keep it out of the first cold visit.
  await (await fetch(`${url}/index.html`)).arrayBuffer();
  return url;
}

async function profile(browser: string, target: Target, variant: Variant, attempt: number): Promise<Visit[]> {
  const type = types[browser];
  if (!type) throw new Error(`Unknown browser ${browser}`);
  const directory = await mkdtemp(join(profiles, `${browser}-`));
  const results: Visit[] = [];
  try {
    for (const visit of ["cold", "warm"]) {
      const run = `${variant.name ? `${variant.name}-` : ""}${browser}-${target.app}-${target.engine}-${visit}-${attempt}`;
      results.push(await visitOnce(type, directory, run, target, servers.get(`${variant.name}:${target.app}`)!));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return results;
}

/** One browser launch on the profile: a fresh one is cold, a reused one warm. */
async function visitOnce(type: BrowserType, directory: string, run: string, target: Target, base: string): Promise<Visit> {
  return contexts.open(
    () => type.launchPersistentContext(directory, { headless: true, viewport: { width: 1440, height: 900 } }),
    context => load(context, run, target, base),
  );
}

async function load(context: BrowserContext, run: string, target: Target, base: string): Promise<Visit> {
  await context.addInitScript(installPageLoadObserver);
  const page = context.pages()[0] ?? await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  const workers: PlaywrightWorker[] = [];
  page.on("worker", worker => {
    workers.push(worker);
    void worker.evaluate(installStorageReadCounter).catch(() => {});
  });
  const url = new URL(base);
  url.pathname = "/";
  url.searchParams.set("engine", target.engine);
  if (template && target.app === "sandbox") url.searchParams.set("template", template);
  await page.goto(url.href);
  let error: string | null = null;
  try {
    await page.waitForFunction(readyState, target.app, { timeout, polling: 100 });
  } catch (caught) {
    error = String(caught).split("\n")[0]!;
  }
  const visit = await snapshot(page, run, target.app);
  const origin = await page.evaluate(() => performance.timeOrigin);
  const reads = await storageReads(workers);
  visit.storage = storagePhases(visit, origin, reads);
  await writeFile(join(out, `${run}.reads.json`), JSON.stringify(reads.map(read => ({ ...read, start: read.start - origin, end: read.end - origin }))));
  visit.error ??= error ?? (errors.length ? errors.join("; ") : null);
  await writeFile(join(out, `${run}.json`), `${JSON.stringify(visit, null, 2)}\n`);
  console.log(`${run}: ${visit.ready === null ? `not ready (${visit.error})` : `ready at ${visit.ready.toFixed(0)} ms`}`);
  return visit;
}

declare const __pageLoad: { state(app: string): PageLoadState };

/** True when the app reached its first usable state, or a startup error it will not leave. */
function readyState(app: string): boolean {
  const { ready, error } = __pageLoad.state(app);
  return ready !== null || error !== null;
}

async function snapshot(page: Page, run: string, app: App): Promise<Visit> {
  const data = await page.evaluate((app) => {
    const entries = performance.getEntries().filter(entry => entry.name.startsWith("bunwasm:")).map(entry => ({
      name: entry.name, type: entry.entryType, start: entry.startTime, end: entry.startTime + entry.duration,
      detail: (entry as PerformanceMark).detail ?? undefined,
    }));
    const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map(entry => ({
      name: new URL(entry.name).pathname, start: entry.startTime, end: entry.responseEnd,
      transfer: entry.transferSize, encoded: entry.encodedBodySize, decoded: entry.decodedBodySize,
    }));
    const [navigation] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return {
      ...__pageLoad.state(app), entries, resources,
      navigation: (navigation ? { responseEnd: navigation.responseEnd, domContentLoaded: navigation.domContentLoadedEventEnd, load: navigation.loadEventEnd } : {}) as Record<string, number>,
    };
  }, app);
  return { run, ...data, storage: [] };
}

/** Guest workers can sit in `Atomics.wait`, where an evaluation never runs; those count as none. */
async function storageReads(workers: readonly PlaywrightWorker[]): Promise<StorageRead[]> {
  const read = (worker: PlaywrightWorker) => Promise.race([
    worker.evaluate(() => (globalThis as { __storageReads?: StorageRead[] }).__storageReads ?? []).catch(() => []),
    new Promise<StorageRead[]>(resolve => setTimeout(resolve, 2_000, [])),
  ]);
  return (await Promise.all(workers.map(read))).flat();
}

/** Buckets storage reads by the sandbox stage each one started in. */
function storagePhases(visit: Visit, origin: number, reads: readonly StorageRead[]): StoragePhase[] {
  const stages = visit.entries.filter(entry => entry.name.startsWith("bunwasm:stage:") || entry.name === "bunwasm:dev-server" || entry.name === "bunwasm:preview")
    .map(entry => ({ phase: entry.name.replace(/^bunwasm:(stage:)?/, ""), until: entry.end }))
    .sort((a, b) => a.until - b.until)
    .concat([{ phase: "after-ready", until: Number.POSITIVE_INFINITY }]);
  const phases: StoragePhase[] = stages.map(stage => ({ ...stage, reads: 0, bytes: 0, readMs: 0, digests: 0, digestMs: 0, files: {} }));
  for (const read of reads) {
    const at = read.start - origin;
    const phase = phases.find(item => at <= item.until)!;
    if (read.kind === "digest") { phase.digests++; phase.digestMs += read.end - read.start; continue; }
    if (read.file !== undefined) phase.files[read.file] = (phase.files[read.file] ?? 0) + 1;
    phase.reads++;
    phase.bytes += read.bytes;
    phase.readMs += read.end - read.start;
  }
  return phases;
}

function stageTime(visit: Visit, column: string): string {
  if (column === "ready") return visit.ready === null ? `✗ ${visit.error ?? "timeout"}` : visit.ready.toFixed(0);
  if (column in visit.navigation) return visit.navigation[column]!.toFixed(0);
  const entry = visit.entries.find(item => item.name === `bunwasm:stage:${column}`) ?? visit.entries.find(item => item.name === `bunwasm:${column}`);
  return entry ? entry.end.toFixed(0) : "";
}

function summary(all: Visit[]): string {
  let text = "";
  for (const app of ["web", "sandbox"] as const) {
    const rows = all.filter(visit => visit.run.includes(`-${app}-`));
    if (!rows.length) continue;
    const header = `| Run | ${columns[app].join(" | ")} |\n| --- |${columns[app].map(() => " ---: |").join("")}\n`;
    text += `\n### ${app} medians\n\n${header}`;
    const groups = Map.groupBy(rows, visit => visit.run.replace(/-\d+$/, ""));
    for (const [group, visits] of Array.from(groups).sort(([a], [b]) => a.localeCompare(b))) {
      text += `| ${group} (${visits.length}) | ${columns[app].map(column => median(visits.map(visit => Number.parseFloat(stageTime(visit, column))))).join(" | ")} |\n`;
    }
    text += `\n### ${app} runs\n\n${header}`;
    for (const visit of rows) text += `| ${visit.run} | ${columns[app].map(column => stageTime(visit, column)).join(" | ")} |\n`;
    text += "\nEngine loader spans (start–end ms):\n\n";
    for (const visit of rows) {
      const spans = visit.entries.filter(entry => entry.type === "measure" && /cache-lookup|cache-read|download|verify|prepare|compile|decompress/.test(entry.name));
      text += `- ${visit.run}: ${spans.map(span => `${span.name.slice(8)}${nameOf(span.detail)} ${span.start.toFixed(0)}–${span.end.toFixed(0)}`).join(", ")}\n`;
    }
    text += "\nIndexedDB reads per stage (reads / MB / summed request ms; SHA-256 digests / ms), each counted in the stage it started in:\n\n";
    for (const visit of rows) text += storageSummary(visit);
  }
  return text;
}

function storageSummary(visit: Visit): string {
  const phases = visit.storage.filter(phase => phase.reads || phase.digests);
  let text = `- ${visit.run}: ${phases.map(phase => `${phase.phase} ${phase.reads}/${(phase.bytes / 1048576).toFixed(1)}/${phase.readMs.toFixed(0)}; ${phase.digests}/${phase.digestMs.toFixed(0)}`).join(" · ")}\n`;
  // Files are named by their size; a file read as ranges shows one manifest read per range.
  for (const phase of phases) {
    const top = Object.entries(phase.files).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length && top[0]![1] > 20) text += `  - ${phase.phase} most-read files (bytes × manifest reads): ${top.map(([size, count]) => `${size} × ${count}`).join(", ")}\n`;
  }
  return text;
}

function median(values: number[]): string {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return "";
  const middle = sorted.length >> 1;
  return (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2).toFixed(0);
}

function nameOf(detail: unknown): string {
  return detail && typeof detail === "object" && "name" in detail ? `(${String(detail.name).split("/").pop()})` : "";
}
