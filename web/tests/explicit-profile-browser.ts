// Exercise the shipped playground and unchanged guest assertions, not a fixture-only loader.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import type { Runtime } from "waffle";
import { stageFixtureTree } from "../../scripts/fixture-tree";
import { verifySite } from "../../scripts/browser-guest-site";
import { stageSharedPrograms } from "../../scripts/stage-program-profiles";
import { BUN_MEMORY_GROUP_POLICY, isPairedEngine, programKind, programProfile } from "../../src/engine-kind";

declare const playground: {
  runtime: Runtime;
  profile: string;
  fs: Runtime["filesystem"];
  shell: { submit(text: string): Promise<void>; lastExit: number; running: boolean };
  sharedObjects: { inspect(): unknown; inspectTransfers(): unknown; close(): void };
  term: { write(text: string, callback: () => void): void; buffer: { active: { length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined } } };
};

let scratch: string | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleaning: Promise<void> | undefined;
const cleanup = () => cleaning ??= (async () => {
  try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
  finally { await server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
})();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("explicit profile browser deadline"); void cleanup().finally(() => process.exit(1)); }, 300_000);

async function site(): Promise<string> {
  const verified = process.env.BUN_WASM_BROWSER_SITE;
  if (verified) verifySite(verified);
  const source = verified ? join(verified, "site") : process.env.BUN_WASM_EXPLICIT_PROFILE_SITE;
  assert.ok(source, "Set BUN_WASM_BROWSER_SITE or BUN_WASM_EXPLICIT_PROFILE_SITE to a production playground");
  scratch = await mkdtemp(join(tmpdir(), "bw-profile-"));
  const root = join(scratch, "site");
  await cp(source, root, { recursive: true });
  const program = process.env.BUN_WASM_PROFILE_PROGRAM;
  if (program) {
    const kind = programKind(new WebAssembly.Module(await Bun.file(program).bytes()));
    assert.ok(isPairedEngine(kind), "Existing shared paired producer required");
    const builds: Record<string, string> = await Bun.file(join(root, "engine-builds.json")).json();
    await stageSharedPrograms(root, builds, { quickjs: kind === "quickjs" ? dirname(program) : undefined, jsc: kind === "jsc" ? dirname(program) : undefined, spidermonkey: kind === "spidermonkey" ? dirname(program) : undefined });
    const html = await Bun.file(join(root, "index.html")).text();
    await Bun.write(join(root, "index.html"), html.replace(/globalThis\.__bunwasmBuilds\s*=\s*\{[^;]*?\}/, `globalThis.__bunwasmBuilds=${JSON.stringify(builds)}`));
    await Bun.write(join(root, "engine-builds.json"), JSON.stringify(builds));
  }
  return root;
}

function serve(root: string): number {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const path = resolve(root, `.${url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname)}`);
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
    if (!path.startsWith(root + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  assert.ok(server.port);
  return server.port;
}

async function ready(page: Page, base: string, engine: string, profile: string): Promise<void> {
  await page.goto(`${base}?engine=${engine}&profile=${profile}&mode=memory&prompt=off`);
  await page.waitForFunction(() => typeof playground !== "undefined", undefined, { timeout: 60_000 });
  assert.equal(await page.evaluate(() => playground.profile), profile);
}

async function fixture(page: Page, directory: string): Promise<void> {
  const entries = await stageFixtureTree(resolve(import.meta.dir, "../../tests/fixtures/shared-wasm-memory"), directory);
  const files = await Promise.all(entries.filter(entry => entry.kind === "file").map(async entry => ({ path: entry.path, bytes: Array.from(await readFile(join(directory, entry.path))) })));
  await page.evaluate(async files => {
    for (const file of files) {
      const path = `/home/user/fixture/${file.path}`;
      await playground.fs.mkdirp(path.slice(0, path.lastIndexOf("/")));
      await playground.fs.writeFile(path, Uint8Array.from(file.bytes));
    }
    await playground.fs.flush();
  }, files);
}

async function command(page: Page, text: string) {
  return page.evaluate(async text => {
    const processes = await playground.runtime.processes();
    const peaks = { groups: 0, members: 0, retained: 0, committedBytes: 0 };
    const owners = new Set<string>();
    const sample = () => {
      const groups = processes.memoryGroups();
      for (const group of groups) owners.add(group.id);
      peaks.groups = Math.max(peaks.groups, groups.length);
      peaks.members = Math.max(peaks.members, groups.reduce((sum, group) => sum + group.members, 0));
      peaks.retained = Math.max(peaks.retained, groups.reduce((sum, group) => sum + group.retained, 0));
      peaks.committedBytes = Math.max(peaks.committedBytes, groups.reduce((sum, group) => sum + group.committedBytes, 0));
    };
    const sampling = setInterval(sample, 5);
    try { await playground.shell.submit(text); }
    finally { sample(); clearInterval(sampling); }
    await new Promise<void>(resolve => playground.term.write("", resolve));
    const buffer = playground.term.buffer.active;
    return { code: playground.shell.lastExit, peaks, ownerCount: owners.size, output: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n") };
  }, text);
}

async function settled(page: Page): Promise<void> {
  await page.waitForFunction(async () => (await playground.runtime.processes()).memoryGroups().length === 0, undefined, { timeout: 30_000 });
  assert.deepEqual(await page.evaluate(async () => (await playground.runtime.processes()).memoryGroups()), []);
  assert.deepEqual(await page.evaluate(() => playground.sharedObjects.inspect()), { clients: 0, objects: 0, waiting: 0 });
  assert.deepEqual(await page.evaluate(() => playground.sharedObjects.inspectTransfers()), { pins: 0, attaching: 0 });
}

async function shared(page: Page, base: string, engine: string): Promise<void> {
  await ready(page, base, engine, "shared-group");
  await fixture(page, join(scratch!, `fixture-${engine}`));
  for (const entry of ["plain-sab", "profile-worker"]) {
    // The shell, Bun.spawn inside the fixture, and Worker children all use the registered program.
    const result = await command(page, `bun run /home/user/fixture/${entry}.ts`);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes(`${entry}: pass`), result.output);
    await settled(page);
    assert.ok(result.peaks.groups > 0, "the production run never observed a group");
    if (entry === "profile-worker") assert.ok(result.peaks.groups >= 2, "ordinary child processes create separate groups");
    console.log(JSON.stringify({ engine, profile: "shared-group", entry, code: result.code, peaks: result.peaks, ownerCount: result.ownerCount, owners: "settled", policy: BUN_MEMORY_GROUP_POLICY }));
  }
}

async function mismatch(base: string, root: string): Promise<void> {
  const page = await browser!.newPage();
  const builds: Record<string, string> = await Bun.file(join(root, "engine-builds.json")).json();
  for (const name of ["bun.wasm", "quickjs.wasm"]) builds[`profiles/shared-group/${name}`] = builds[name]!;
  const html = (await Bun.file(join(root, "index.html")).text()).replace(/globalThis\.__bunwasmBuilds\s*=\s*\{[^;]*?\}/, `globalThis.__bunwasmBuilds=${JSON.stringify(builds)}`);
  const requests: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === "/") return route.fulfill({ body: html, contentType: "text/html", headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
    if (!url.pathname.startsWith("/profiles/shared-group/")) return route.continue();
    const name = url.pathname.slice("/profiles/shared-group/".length);
    return route.fulfill({ body: Buffer.from(await Bun.file(join(root, name)).arrayBuffer()), contentType: "application/wasm" });
  });
  await page.goto(`${base}?engine=quickjs&profile=shared-group&mode=memory&prompt=off`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("profile mismatch"), undefined, { timeout: 60_000 });
  assert.equal(await page.evaluate(() => typeof playground), "undefined");
  assert.equal(requests.some(path => path === "/bun.wasm.gz" || path === "/quickjs.wasm.gz"), false, "a refused shared profile never retries split assets");
  assert.deepEqual(errors, []);
  await page.close();
  console.log(JSON.stringify({ mismatchedPair: "refused", profileFallback: false }));
}

async function poisonedCache(page: Page, base: string, root: string, engine: "quickjs" | "jsc" | "spidermonkey"): Promise<void> {
  const core = programProfile(engine).core;
  const builds: Record<string, string> = await Bun.file(join(root, "engine-builds.json")).json();
  const hash = builds[`profiles/shared-group/${core}`];
  assert.ok(hash);
  await page.evaluate(async ({ base, core, hash }) => {
    const cache = await caches.open("bunwasm-engines");
    const split = await cache.match(new URL("bun.wasm", base));
    if (!split) throw new Error("Missing verified split cache entry");
    const target = new URL(`profiles/shared-group/${core}?profile=shared-group`, base);
    await cache.put(target, new Response(split.body, { headers: { "x-bunwasm-build": hash } }));
  }, { base, core, hash });
  const requests: string[] = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.goto(`${base}?engine=${engine}&profile=shared-group&mode=memory&prompt=off`);
  await page.waitForFunction(() => document.querySelector("#status")?.textContent?.includes("integrity mismatch"), undefined, { timeout: 60_000 });
  assert.equal(requests.some(path => path.endsWith(".wasm.gz") || path.endsWith(".wasm")), false, "a poisoned verified cache refuses execution without a profile retry");
  console.log(JSON.stringify({ poisonedCache: "refused", profileFallback: false }));
}

try {
  const root = await site();
  console.log(JSON.stringify({ resources: { scratch, site: root, listener: "ephemeral loopback", browser: "Chromium", downloads: "none" } }));
  const port = serve(root), base = `http://127.0.0.1:${port}/`;
  browser = await (launching = chromium.launch({ headless: true, args: ["--no-sandbox"] }));
  const page = await browser.newPage();
  page.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  page.on("pageerror", error => console.error(String(error)));
  const program = process.env.BUN_WASM_PROFILE_PROGRAM;
  const selected = program ? [programKind(new WebAssembly.Module(await Bun.file(program).bytes()))] : ["quickjs", "jsc"];
  for (const engine of selected) await shared(page, base, engine);
  await ready(page, base, "quickjs", "split");
  await fixture(page, join(scratch!, "fixture-split"));
  const refusal = await command(page, "bun run /home/user/fixture/cross-worker.ts");
  assert.notEqual(refusal.code, 0, refusal.output);
  assert.match(refusal.output, /shared|Shared/);
  await settled(page);
  const keys = await page.evaluate(async () => Array.from(await (await caches.open("bunwasm-engines")).keys(), request => request.url));
  assert.ok(keys.some(key => key.includes("/profiles/shared-group/")), "shared cache entries missing");
  assert.ok(keys.some(key => new URL(key).pathname === "/bun.wasm"), "split cache entries missing");
  await page.evaluate(async () => { playground.sharedObjects.close(); await playground.runtime.dispose(); });
  assert.equal(await page.evaluate(() => playground.runtime.disposed), true);
  const first = selected[0];
  assert.ok(first && isPairedEngine(first));
  await poisonedCache(page, base, root, first);
  await page.close();
  await mismatch(base, root);
  console.log(JSON.stringify({ splitRefusal: true, cacheProfiles: "distinct", page: "disposed" }));
} finally {
  clearTimeout(deadline);
  await cleanup();
  if (process.env.BUN_WASM_BROWSER_SITE) verifySite(process.env.BUN_WASM_BROWSER_SITE);
}
