import { browserType } from "./browser-type.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { session, ready, writeFile, run, web } from "./playground.mjs";

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
const deadline = setTimeout(() => { void s.cleanup().finally(() => process.exit(1)); }, 300000);
try {
  const url = await s.serve();
  for (const name of browsers.length ? browsers : ["chromium", "webkit"]) {
    for (const engine of engines) {
      await checkTools(name, engine, url);
    }
  }
} finally { clearTimeout(deadline); await s.cleanup(); }

async function checkTools(name: string, engine: string, url: string): Promise<void> {
  const context = await s.launch({ launch: () => browserType(name).launchPersistentContext(join(s.scratch, `${name}-${engine}`)) });
  const page = await context.newPage();
  const downloads: string[] = [];
  page.on("request", request => { if (request.url().includes("bun-tools.wasm")) downloads.push(request.url()); });
  await page.goto(`${url}?engine=${engine}&prompt=off`);
  assert.match(await ready(page), /ready/);
  await writeFile(page, "/home/user/tool-source.ts", "export const answer: number = 42;\n");
  assert.equal((await run(page, "bun run tool-source.ts")).code, 0);
  assert.equal((await run(page, "bun build tool-source.ts --outdir out")).code, 0);
  assert.deepEqual(downloads, [], "ordinary page, run and build must not fetch tools");
  await page.evaluate(() => {
    const compile = WebAssembly.compile.bind(WebAssembly);
    WebAssembly.compile = async bytes => {
      const current = Number(Reflect.get(globalThis, "__bunwasmCompileCount") ?? 0);
      Reflect.set(globalThis, "__bunwasmCompileCount", current + 1);
      return compile(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice().buffer : new Uint8Array(bytes).buffer);
    };
    Reflect.set(globalThis, "__bunwasmCompileCount", 0);
  });
  const substituted = readFileSync(join(root, "bun.wasm.gz"));
  await page.route("**/bun-tools.wasm.gz*", route => route.fulfill({
    status: 200,
    headers: { "content-type": "application/wasm" },
    body: substituted,
  }));
  const rejected = await run(page, "bun lint tool-source.ts");
  assert.equal(rejected.code, 126, rejected.output);
  const hashes = await page.evaluate(() => {
    const builds = Reflect.get(globalThis, "__bunwasmBuilds");
    return { expected: builds["bun-tools.wasm"], received: builds["bun.wasm"] };
  });
  assert.ok(rejected.output.includes(`bun-tools.wasm integrity mismatch: expected ${hashes.expected}, received ${hashes.received}`), rejected.output);
  assert.equal(await page.evaluate(() => Number(Reflect.get(globalThis, "__bunwasmCompileCount"))), 0, "mismatched tools are rejected before compilation");
  const cacheHit = await page.evaluate(toolsCached);
  assert.equal(cacheHit, false, "mismatched tools are not cached");
  console.log(JSON.stringify({ coverage: "tools-integrity", phase: "wrong-payload", browser: name, engine,
    exit: rejected.code, expected: hashes.expected, received: hashes.received, compileCount: 0, cacheHit }));
  await page.unroute("**/bun-tools.wasm.gz*");
  const first = await run(page, "bun lint tool-source.ts");
  assert.equal(first.code, 0, first.output);
  assert.equal(downloads.length, 2, "the rejected and verified lint each fetch tools once");
  assert.equal(await page.evaluate(() => Number(Reflect.get(globalThis, "__bunwasmCompileCount"))), 1, "verified tools compile once");
  assert.equal((await run(page, "bun fmt --check tool-source.ts")).code, 0);
  assert.equal(downloads.length, 2, "fmt reuses compiled tools");
  await page.waitForFunction(() => {
    const key = new URL("bun-tools.wasm", location.href).href;
    const build = Reflect.get(globalThis, "__bunwasmBuilds")["bun-tools.wasm"];
    return performance.getEntriesByName("bunwasm:engine-cache-stored").some(entry => {
      const detail = Reflect.get(entry, "detail");
      return detail?.url === key && detail?.build === build;
    });
  });
  const cold = await page.evaluate(() => performance.getEntriesByType("resource").filter(entry => entry.name.includes("bun-tools.wasm")).map(entry => ({ url: entry.name, duration: entry.duration, transferSize: Reflect.get(entry, "transferSize") })));
  await page.reload();
  await ready(page);
  await writeFile(page, "/home/user/tool-source.ts", "export const answer: number = 42;\n");
  assert.equal((await run(page, "bun lint tool-source.ts")).code, 0);
  console.log(JSON.stringify({ browser: name, engine, firstLintMs: first.ms, downloads, resources: cold }));
  assert.equal(downloads.length, 2, "reload compiles tools from persistent cache");
  await context.close();
  console.log(JSON.stringify({ coverage: "tools-integrity", phase: "complete", browser: name, engine }));
}

async function toolsCached(): Promise<boolean> {
  for (const name of await caches.keys()) {
    const entries = await (await caches.open(name)).keys();
    if (entries.some(entry => new URL(entry.url).pathname.includes("bun-tools.wasm"))) return true;
  }
  return false;
}
