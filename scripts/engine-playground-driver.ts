import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { programProfile } from "../src/engine-kind.ts";
import type { Browser, Page, BrowserContext } from "playwright";
import { verifyPlaygroundBuilds } from "./app-matrix/product-provenance.ts";
import { boundedCleanup, HarnessCleanupError } from "./app-matrix/cleanup.ts";
import type { ChromiumContext, ChromiumDriver, censusChild } from "./app-matrix/engine-arms.ts";
import { sha256 } from "./engine-arm-registry.ts";
import { compileDuration, compileRequest, type CompileRequest } from "./engine-compile-observation.ts";

import type {} from "../web/src/compile-observer.ts";

type Child = ReturnType<typeof censusChild>;
export interface PlaygroundWorkload {
  readonly name: string;
  readonly command: string;
  readonly files: Readonly<Record<string, string>>;
  check(stdout: string): void;
}
interface PlaygroundControls {
  ready(page: Page, timeout: number): Promise<string>;
  run(page: Page, command: string, timeout: number): Promise<{ code: number | null; ms: number; output: string }>;
  writeFile(page: Page, path: string, contents: string): Promise<void>;
}
export interface HostCompileObserver {
  begin(page: Page, request: CompileRequest): Promise<void>;
  end(page: Page, request: CompileRequest): Promise<unknown>;
}

/** Page bridge for the optional direct WebAssembly compiler-span emitter. */
export const playgroundCompileObserver: HostCompileObserver = {
  async begin(page, request) {
    if (page.url() === "about:blank") {
      await page.addInitScript(value => { globalThis.__bunwasmCompileRequest = value; }, request);
      return;
    }
    await page.evaluate(value => { globalThis.__bunwasmCompileObserver?.begin(value); }, request);
  },
  end: (page, request) => page.evaluate(value => globalThis.__bunwasmCompileObserver?.end(value) ?? null, request),
};
interface DriverOptions {
  readonly browser: Pick<Browser, "newContext">;
  readonly url: string;
  readonly workloads: readonly PlaygroundWorkload[];
  readonly controls: PlaygroundControls;
  readonly timeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly compileObserver?: HostCompileObserver;
}

export function playgroundFixtures(workloads: readonly PlaygroundWorkload[]): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const workload of workloads) {
    for (const [path, contents] of Object.entries(workload.files)) {
      assert.ok(!files.has(path) || files.get(path) === contents, `conflicting fixed fixture ${path}`);
      files.set(path, contents);
    }
  }
  return files;
}

function assetNames(child: Child) {
  if (child.program.kind === "single") return { core: "bun-browser.wasm", side: null };
  return programProfile(child.program.kind);
}

export function playgroundCommand(child: Child, command: string): string {
  const tier = child.environment.BUN_WASM_SPIDERMONKEY_TIER;
  assert.equal(tier ?? null, child.tier, "child tier environment differs");
  return tier ? `BUN_WASM_SPIDERMONKEY_TIER=${tier} ${command}` : command;
}

// The URL selects an authoritative engine kind. Arm labels only namespace the
// fresh context and its caches; they are never passed as ?engine= aliases.
export function playgroundURL(base: string, child: Child): string {
  const url = new URL(base);
  assert.ok(url.protocol === "http:" || url.protocol === "https:", "playground requires an HTTP URL");
  url.searchParams.set("engine", child.engine);
  url.searchParams.set("prompt", "off");
  url.searchParams.set("measurement-arm", child.cacheIdentity);
  url.searchParams.delete("wasm");
  url.searchParams.delete("measurement-tier");
  if (child.tier) url.searchParams.set("measurement-tier", child.tier);
  return url.href;
}

export function playgroundChromiumDriver(options: DriverOptions): ChromiumDriver {
  assert.ok(options.workloads.length && new Set(options.workloads.map(workload => workload.name)).size === options.workloads.length, "choose distinct workloads");
  assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0, "workload timeout must be positive");
  return { async open(child) {
    const context = await options.browser.newContext({ serviceWorkers: "allow" });
    try { return await openPlaygroundContext(context, child, options); }
    catch (cause) {
      const failed = await boundedCleanup("measurement-context-open", () => context.close(), options.cleanupTimeoutMs);
      if (failed) throw new HarnessCleanupError([failed], cause);
      throw cause;
    }
  } };
}

export function servedProgram(context: BrowserContext, child: Child, base: string) {
  const names = assetNames(child);
  const files = [{ name: names.core, raw: child.program.core, gzip: child.servedGzip.core }];
  if (child.program.kind !== "single" && child.servedGzip.kind !== "single" && names.side) files.push({ name: names.side, raw: child.program.side, gzip: child.servedGzip.side });
  const received = new Map<string, Promise<string | null>[]>();
  context.on("response", response => {
    const url = new URL(response.url());
    const file = files.find(file => {
      const asset = new URL(file.name, base);
      return url.origin === asset.origin && url.pathname.replace(/\.gz$/, "") === asset.pathname;
    });
    if (!file || response.status() === 404 && url.pathname.endsWith(".gz")) return;
    const identity = url.pathname.endsWith(".gz") ? file.gzip : file.raw;
    const observation = response.body().then(bytes => {
      assert.ok(response.ok(), `artifact HTTP ${response.status()}`);
      assert.equal(bytes.length, identity.bytes, "served artifact byte count differs");
      assert.equal(sha256(bytes), identity.sha256, "served artifact digest differs");
      return null;
    }).catch(String);
    received.set(file.name, (received.get(file.name) ?? []).concat([observation]));
  });
  return async (page: Page) => {
    const builds: unknown = await page.evaluate(() => Reflect.get(globalThis, "__bunwasmBuilds"));
    verifyPlaygroundBuilds(builds, Object.fromEntries(files.map(file => [file.name, file.raw.sha256])));
    for (const file of files) {
      const observations = received.get(file.name);
      assert.ok(observations?.length, `fresh context did not fetch admitted ${file.name}`);
      for (const observation of observations) assert.equal(await observation, null, `served ${file.name} differs`);
    }
  };
}

async function openPlaygroundContext(context: BrowserContext, child: Child, options: DriverOptions): Promise<ChromiumContext> {
  const page = await context.newPage();
  const verifyServed = servedProgram(context, child, options.url);
  const identity = randomUUID();
  const startupRequest = compileRequest(child, "chromium", `${identity}/engine-ready`);
  await options.compileObserver?.begin(page, startupRequest);
  const started = performance.now();
  await page.goto(playgroundURL(options.url, child), { timeout: options.timeoutMs });
  const status = await options.controls.ready(page, options.timeoutMs);
  assert.ok(status.includes("ready"), `playground engine is not ready: ${status}`);
  const readyMs = performance.now() - started;
  const startupCompileMs = compileDuration(await options.compileObserver?.end(page, startupRequest) ?? null, startupRequest);
  await verifyServed(page);
  for (const [path, contents] of playgroundFixtures(options.workloads)) await options.controls.writeFile(page, path, contents);
  let sequence = 0;
  return {
    async measure(name) {
      if (name === "engine-ready") return { wallMs: readyMs, compileMs: startupCompileMs };
      const workload = options.workloads.find(workload => workload.name === name);
      assert.ok(workload, `unknown playground workload ${name}`);
      const request = compileRequest(child, "chromium", `${identity}/${++sequence}/${name}`);
      await options.compileObserver?.begin(page, request);
      let observation: unknown = null;
      const result = await options.controls.run(page, playgroundCommand(child, workload.command), options.timeoutMs)
        .finally(async () => { observation = await options.compileObserver?.end(page, request) ?? null; });
      assert.equal(result.code, 0, `guest exit ${result.code}: ${result.output}`);
      assert.ok(Number.isFinite(result.ms) && result.ms >= 0, "invalid command duration");
      workload.check(result.output);
      return { wallMs: result.ms, compileMs: compileDuration(observation, request) };
    },
    close: () => context.close(),
  };
}
