// PC build: bun web/tests/browser-filesystem-lifecycle.ts --build <directory>
// Mac: bun browser-filesystem-lifecycle.ts safari http://127.0.0.1:<port>/
import assert from "node:assert/strict";
import { resolve } from "node:path";

const mode = process.argv[2] ?? "chromium";
const assets = process.argv[3];
if (mode === "safari") assert.ok(assets, "Pass the URL of the prebuilt lifecycle fixture");
async function build(directory: string) {
  const root = resolve(import.meta.dir, "../..");
  const entries: [string, string][] = [["web/tests/fixtures/filesystem-lifecycle.ts", "main"], ["web/src/fs-worker.ts", "fs-worker"]];
  for (const [entry, name] of entries) {
    const result = await Bun.build({ entrypoints: [resolve(root, entry)], outdir: directory, naming: `${name}.js`, target: "browser", format: "esm",
      plugins: [{ name: "source-runtime", setup(build) {
        build.onResolve({ filter: /^@bun-wasm\/runtime\/fs$/ }, () => ({ path: resolve(root, "runtime/fs/index.ts") }));
      } }],
    });
    assert.equal(result.success, true, result.logs.map(String).join("\n"));
  }
  await Bun.write(resolve(directory, "index.html"), '<!doctype html><meta name="viewport" content="width=device-width"><body>Filesystem lifecycle check<script type="module" src="/main.js"></script>');
  await Bun.write(resolve(directory, "away.html"), "<!doctype html><body>Another page");
}
if (mode === "--build") { assert.ok(assets); await build(assets); process.exit(0); }

type Driver = {
  evaluate(script: string): Promise<unknown>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  back(expected: string): Promise<void>;
  current(): Promise<string>;
  open(): Promise<string>;
  select(handle: string): Promise<void>;
  close(): Promise<void>;
  handles(): Promise<string[]>;
  screenshot?(path: string): Promise<void>;
};
let stop: (() => Promise<void>) | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let scratch: string | undefined;
const report: Record<string, unknown> & { cases: unknown[] } = { mode, cases: [] };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object"; }
function text(value: unknown): string { assert.ok(typeof value === "string"); return value; }
let cleaning: Promise<void> | undefined;
function cleanup() {
  return cleaning ??= (async () => {
    try { await stop?.(); }
    finally {
      server?.stop(true);
      if (scratch) await import("node:fs/promises").then(fs => fs.rm(scratch!, { recursive: true, force: true }));
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 240_000);

async function safari(): Promise<Driver> {
  const port = Number(process.env.SAFARI_DRIVER_PORT ?? 43362);
  const endpoint = `http://127.0.0.1:${port}`;
  let session: string | undefined;
  assert.equal(await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false), false, "driver port must be free");
  const processHandle = Bun.spawn(["/usr/bin/safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "ignore" });
  async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(endpoint + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(cleaning ? 5_000 : 45_000) });
    const result: unknown = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    assert.ok(record(result));
    return result.value;
  }
  stop = async () => {
    try { if (session) await request(`/session/${session}`, undefined, "DELETE"); }
    finally { processHandle.kill(); await processHandle.exited; }
  };
  for (let attempt = 0; ; attempt++) {
    try { await request("/status"); break; }
    catch (error) { if (attempt === 40) throw error; await Bun.sleep(100); }
  }
  const caps = process.env.SAFARI_IOS === "1"
    ? { browserName: "safari", platformName: "ios", "safari:useSimulator": true, "safari:deviceType": "iPhone", "safari:deviceName": "iPhone 17 Pro" }
    : { browserName: "safari" };
  const opened = await request("/session", { capabilities: { alwaysMatch: caps } });
  assert.ok(record(opened) && typeof opened.sessionId === "string");
  session = opened.sessionId;
  report.capabilities = opened.capabilities;
  const path = `/session/${session}`;
  await request(`${path}/timeouts`, { script: 30_000, pageLoad: 30_000, implicit: 0 });
  async function barrier(expected?: string) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const state = await request(`${path}/execute/sync`, { script: "return {url:location.href,ready:document.readyState}", args: [] });
      assert.ok(record(state));
      if ((!expected || state.url === expected) && state.ready === "complete") return;
      await Bun.sleep(25);
    }
    throw new Error("Safari navigation did not complete");
  }
  return {
    async evaluate(script) {
      const result = await request(`${path}/execute/async`, { script: `const done=arguments[arguments.length-1];Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error),stack:error?.stack}));`, args: [] });
      assert.ok(record(result)); assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
    },
    async navigate(url) { await request(`${path}/url`, { url }); await barrier(url); },
    async reload() { await request(`${path}/refresh`, {}); await barrier(); },
    async back(expected) { await request(`${path}/back`, {}); await barrier(expected); },
    async current() { return text(await request(`${path}/window`)); },
    async open() { const result = await request(`${path}/window/new`, { type: "tab" }); assert.ok(record(result)); return text(result.handle); },
    async select(handle) { await request(`${path}/window`, { handle }); },
    async close() { await request(`${path}/window`, undefined, "DELETE"); },
    async handles() { const result = await request(`${path}/window/handles`); assert.ok(Array.isArray(result)); return result.map(text); },
    async screenshot(file) { await Bun.write(file, Buffer.from(text(await request(`${path}/screenshot`)), "base64")); },
  };
}

async function playwright(): Promise<Driver> {
  const { mkdtemp } = await import("node:fs/promises");
  scratch = await mkdtemp("/work/tmp/bun-wasm-fs-lifecycle-");
  await build(scratch);
  const directory = scratch;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(resolve(directory, path === "/" ? "index.html" : path.slice(1)));
    return new Response(file, { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } });
  } });
  const pw: typeof import("playwright") = await import(process.env.PLAYWRIGHT ?? "playwright");
  assert.ok(mode === "chromium" || mode === "webkit");
  const browser = await pw[mode].launch({ headless: true });
  stop = () => browser.close();
  const context = await browser.newContext();
  let page = await context.newPage();
  const pages = new Map([["owner", page]]);
  return {
    evaluate: script => page.evaluate(`(async()=>{${script}})()`),
    async navigate(url) { await page.goto(url); },
    async reload() { await page.reload(); },
    async back() { await page.goBack(); },
    async current() { return Array.from(pages).find(([, value]) => value === page)![0]; },
    async open() { const id = crypto.randomUUID(); pages.set(id, await context.newPage()); return id; },
    async select(handle) { const selected = pages.get(handle); assert.ok(selected); page = selected; await page.bringToFront(); },
    async close() { for (const [id, value] of pages) if (value === page) pages.delete(id); await page.close(); },
    async handles() { return Array.from(pages.keys()); },
  };
}

try {
  const driver = mode === "safari" ? await safari() : await playwright();
  const base = assets ?? `http://127.0.0.1:${server!.port}/`;
  async function state() {
    const value = await driver.evaluate("const end=Date.now()+15000;while(!globalThis.lifecycle?.ready&&!globalThis.lifecycle?.error){if(Date.now()>end)throw Error('filesystem startup timed out');await new Promise(r=>setTimeout(r,25))}return {ready:lifecycle.ready,error:lifecycle.error,id:lifecycle.id,events:JSON.parse(sessionStorage.getItem('lifecycle')??'[]'),locks:await navigator.locks.query()};");
    assert.ok(record(value) && typeof value.id === "string" && typeof value.ready === "boolean" && typeof value.error === "string" && Array.isArray(value.events));
    return { id: value.id, ready: value.ready, error: value.error, events: value.events.filter(record), locks: value.locks };
  }
  for (const storage of ["indexeddb", "opfs"]) {
    report.phase = `${storage} initial`;
    const url = new URL(`?storage=${storage}&name=lifecycle-${crypto.randomUUID()}`, base).href;
    await driver.navigate(url);
    const first = await state();
    assert.equal(first.ready, true, JSON.stringify(first));
    // Persisted saves must survive the complete cached-page navigation cycle.
    await driver.evaluate("await lifecycle.fs.writeFile('/saved','before navigation');await lifecycle.fs.flush();return true;");
    await driver.navigate(new URL("away.html", base).href);
    report.phase = `${storage} same-tab reopen`;
    await driver.navigate(url);
    let reopened = await state();
    report.cases.push({ phase: report.phase, ...reopened });
    assert.equal((await driver.handles()).length, 1);
    assert.equal(reopened.ready, true, JSON.stringify(reopened));
    assert.equal(await driver.evaluate("return new TextDecoder().decode(await lifecycle.fs.readFile('/saved'));"), "before navigation");
    await driver.evaluate("await lifecycle.fs.writeFile('/saved','fresh page edit');await lifecycle.fs.flush();return true;");
    report.phase = `${storage} Reload`;
    await driver.reload(); reopened = await state();
    assert.equal(reopened.ready, true, JSON.stringify(reopened));
    assert.equal(await driver.evaluate("return new TextDecoder().decode(await lifecycle.fs.readFile('/saved'));"), "fresh page edit");
    report.phase = `${storage} restore original cached document`;
    await driver.back(new URL("away.html", base).href); await driver.back(url);
    reopened = await state();
    report.cases.push({ phase: report.phase, ...reopened });
    assert.equal(reopened.ready, true, JSON.stringify(reopened));
    assert.notEqual(reopened.id, first.id, "cached filesystem page must reinitialize before use");
    assert.equal(await driver.evaluate("return new TextDecoder().decode(await lifecycle.fs.readFile('/saved'));"), "fresh page edit");
    if (mode === "safari") assert.ok(reopened.events.some(event => event.type === "pageshow" && event.persisted && event.id === first.id), "real Safari must restore the original cached document");
    report.phase = `${storage} two live tabs`;
    const owner = await driver.current(), contender = await driver.open();
    await driver.select(contender); await driver.navigate(url);
    const refused = await state();
    assert.equal(refused.ready, false);
    assert.match(refused.error, /Filesystem already has a writer/);
    report.cases.push({ phase: report.phase, ...refused });
    if (process.env.SAFARI_SCREENSHOT) await driver.screenshot?.(`${process.env.SAFARI_SCREENSHOT}-${storage}.png`);
    await driver.select(owner);
    await driver.evaluate("await lifecycle.fs.writeFile('/saved','live owner edit');await lifecycle.fs.flush();return true;");
    await driver.navigate(new URL("away.html", base).href);
    await driver.select(contender); await driver.reload();
    reopened = await state();
    assert.equal(reopened.ready, true, JSON.stringify(reopened));
    assert.equal(await driver.evaluate("return new TextDecoder().decode(await lifecycle.fs.readFile('/saved'));"), "live owner edit");
    await driver.select(owner); await driver.close(); await driver.select(contender);
    report.phase = `${storage} freeze admission`;
    assert.equal(await driver.evaluate("document.dispatchEvent(new Event('freeze'));try{await lifecycle.fs.writeFile('/late','forbidden');return false}catch{return true}"), true);
    await driver.navigate(new URL("away.html", base).href); await driver.navigate(url);
    assert.equal((await state()).ready, true);
    const replacement = await driver.open(), old = await driver.current();
    await driver.close(); await driver.select(replacement);
    assert.notEqual(replacement, old);
    console.log(`ok ${mode} ${storage}: same-tab reopen, Reload, bfcache restore, two tabs, freeze, durable writes`);
  }
  report.ok = true;
} catch (error) {
  report.error = String(error); throw error;
} finally {
  clearTimeout(deadline); await cleanup();
  if (process.env.SAFARI_OUTPUT) await Bun.write(process.env.SAFARI_OUTPUT, JSON.stringify(report, null, 2) + "\n");
}
