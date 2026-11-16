import { browserType } from "./browser-type.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { session, ready, writeFile, run, web } from "./playground.mjs";
import { ToolsLifecycle } from "./tools-lifecycle.ts";
import { openPlaygroundPage } from "./playground-navigation.ts";

const args = process.argv.slice(2);
const engineArgs = args.filter(arg => arg.startsWith("--engine="));
const rootArgs = args.filter(arg => arg.startsWith("--root="));
assert.ok(engineArgs.length <= 1 && rootArgs.length <= 1, "duplicate engine/root options");
assert.ok(args.every(arg => !arg.startsWith("--") || arg.startsWith("--engine=") || arg.startsWith("--root=")), "unknown tools option");
const selectedEngine = engineArgs[0]?.slice(9);
const engines = ["quickjs", "jsc", "browser"].filter(engine => selectedEngine === undefined || engine === selectedEngine);
assert.ok(engines.length, "--engine must be quickjs, jsc or browser");
const browsers = args.filter(arg => !arg.startsWith("--"));
for (const name of browsers) assert.ok(name === "chromium" || name === "webkit" || name === "firefox", `unsupported browser: ${name}`);
const suppliedRoot = rootArgs[0]?.slice(7);
assert.ok(suppliedRoot === undefined || suppliedRoot.length > 0, "--root must name a site directory");
const root = resolve(suppliedRoot ?? process.env.ROOT ?? join(web, "dist"));
assert.ok(suppliedRoot === undefined || process.env.ROOT === undefined || resolve(process.env.ROOT) === root, "--root disagrees with serving ROOT");
if (suppliedRoot !== undefined) process.env.ROOT = root;
const s = session("bun-wasm-tools-");
process.env.BUN_WASM_NAVIGATION_LOG = join(s.scratch, "navigation.jsonl");
const progress = new ToolsLifecycle();
const deadline = setTimeout(() => { void progress.deadline(() => s.cleanup()).finally(() => process.exit(1)); }, 300000);
await progress.run(async () => {
  const url = await progress.step("server-start", () => s.serve());
  for (const name of browsers.length ? browsers : ["chromium", "webkit"]) {
    for (const engine of engines) {
      await checkTools(name, engine, url);
    }
  }
}, async () => { clearTimeout(deadline); await s.cleanup(); });

async function checkTools(name: string, engine: string, url: string): Promise<void> {
  progress.select(name, engine);
  const context = await progress.step("context-launch", () => s.launch({ launch: () => browserType(name).launchPersistentContext(join(s.scratch, `${name}-${engine}`)) }));
  const page = await progress.step("page-create", () => context.newPage());
  const downloads: string[] = [];
  page.on("request", request => { if (request.url().includes("bun-tools.wasm")) downloads.push(request.url()); });
  assert.match(await progress.step("navigation-and-readiness", () => openPlaygroundPage(page, `${url}?engine=${engine}&prompt=off`, {
    waitUntil: "load", diagnostic: { prefix: "tools-navigation", title: "Tools navigation", fields: { engine } },
  })), /ready/);
  await progress.step("source-write", () => writeFile(page, "/home/user/tool-source.ts", "export const answer: number = 42;\n"));
  assert.equal((await progress.step("ordinary-run", () => run(page, "bun run tool-source.ts"))).code, 0);
  assert.equal((await progress.step("ordinary-build", () => run(page, "bun build tool-source.ts --outdir out"))).code, 0);
  assert.deepEqual(downloads, [], "ordinary page, run and build must not fetch tools");
  await progress.step("compile-observer", () => page.evaluate(() => {
    const compile = WebAssembly.compile.bind(WebAssembly);
    WebAssembly.compile = async bytes => {
      const current = Number(Reflect.get(globalThis, "__bunwasmCompileCount") ?? 0);
      Reflect.set(globalThis, "__bunwasmCompileCount", current + 1);
      return compile(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice().buffer : new Uint8Array(bytes).buffer);
    };
    Reflect.set(globalThis, "__bunwasmCompileCount", 0);
  }));
  const substituted = readFileSync(join(root, "bun.wasm.gz"));
  await progress.step("wrong-payload-route", () => page.route("**/bun-tools.wasm.gz*", route => route.fulfill({
    status: 200,
    headers: { "content-type": "application/wasm" },
    body: substituted,
  })));
  const rejected = await progress.step("wrong-payload-lint", () => run(page, "bun lint tool-source.ts"));
  assert.equal(rejected.code, 126, rejected.output);
  const hashes = await progress.step("wrong-payload-hashes", () => page.evaluate(() => {
    const builds = Reflect.get(globalThis, "__bunwasmBuilds");
    return { expected: builds["bun-tools.wasm"], received: builds["bun.wasm"] };
  }));
  assert.ok(rejected.output.includes(`bun-tools.wasm integrity mismatch: expected ${hashes.expected}, received ${hashes.received}`), rejected.output);
  assert.equal(await progress.step("wrong-payload-compilations", () => page.evaluate(() => Number(Reflect.get(globalThis, "__bunwasmCompileCount")))), 0, "mismatched tools are rejected before compilation");
  const cacheHit = await progress.step("wrong-payload-cache", () => page.evaluate(toolsCached));
  assert.equal(cacheHit, false, "mismatched tools are not cached");
  console.log(JSON.stringify({ coverage: "tools-integrity", phase: "wrong-payload", browser: name, engine,
    exit: rejected.code, expected: hashes.expected, received: hashes.received, compileCount: 0, cacheHit }));
  await progress.step("wrong-payload-unroute", () => page.unroute("**/bun-tools.wasm.gz*"));
  const first = await progress.step("verified-lint", () => run(page, "bun lint tool-source.ts"));
  assert.equal(first.code, 0, first.output);
  assert.equal(downloads.length, 2, "the rejected and verified lint each fetch tools once");
  assert.equal(await progress.step("verified-compilations", () => page.evaluate(() => Number(Reflect.get(globalThis, "__bunwasmCompileCount")))), 1, "verified tools compile once");
  assert.equal((await progress.step("fmt-reuse", () => run(page, "bun fmt --check tool-source.ts"))).code, 0);
  assert.equal(downloads.length, 2, "fmt reuses compiled tools");
  await progress.step("cache-persistence", () => page.waitForFunction(() => {
    const key = new URL("bun-tools.wasm", location.href).href;
    const build = Reflect.get(globalThis, "__bunwasmBuilds")["bun-tools.wasm"];
    return performance.getEntriesByName("bunwasm:engine-cache-stored").some(entry => {
      const detail = Reflect.get(entry, "detail");
      return detail?.url === key && detail?.build === build;
    });
  }));
  const cold = await progress.step("resource-observation", () => page.evaluate(() => performance.getEntriesByType("resource").filter(entry => entry.name.includes("bun-tools.wasm")).map(entry => ({ url: entry.name, duration: entry.duration, transferSize: Reflect.get(entry, "transferSize") }))));
  await progress.step("reload", () => page.reload());
  await progress.step("reload-ready", () => ready(page));
  await progress.step("reload-source-write", () => writeFile(page, "/home/user/tool-source.ts", "export const answer: number = 42;\n"));
  assert.equal((await progress.step("reload-lint", () => run(page, "bun lint tool-source.ts"))).code, 0);
  console.log(JSON.stringify({ browser: name, engine, firstLintMs: first.ms, downloads, resources: cold }));
  assert.equal(downloads.length, 2, "reload compiles tools from persistent cache");
  await progress.step("context-close", () => context.close());
  console.log(JSON.stringify({ coverage: "tools-integrity", phase: "complete", browser: name, engine }));
}

async function toolsCached(): Promise<boolean> {
  for (const name of await caches.keys()) {
    const entries = await (await caches.open(name)).keys();
    if (entries.some(entry => new URL(entry.url).pathname.includes("bun-tools.wasm"))) return true;
  }
  return false;
}
