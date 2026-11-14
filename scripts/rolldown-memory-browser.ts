import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [treeArgument, adapter, result] = process.argv.slice(2);
assert(treeArgument && adapter && result, "Usage: bun rolldown-memory-browser.ts TREE COMPILED_ADAPTER RESULT_JSON");
const tree = resolve(treeArgument);
const directory = join(tree, "node_modules/@rolldown/binding-wasm32-wasi");
const original = join(directory, "rolldown-binding.wasi-browser.js");
const adapted = join(directory, "adapted-browser.js");
const dependencies = (name: string) => import(pathToFileURL(join(tree, "node_modules", name)).href);
const { build } = await dependencies("esbuild/lib/main.js");
const { chromium, webkit } = await dependencies("playwright/index.mjs");
const scratch = mkdtempSync("/work/tmp/bun-wasm-rd-");
const controls: { browser: string; version: string; mode: string; control: unknown }[] = [];
const generated: string[] = [];
const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response("<!doctype html><title>Rolldown control</title>", { headers });
  if (path.endsWith(".wasm")) return new Response(Bun.file(join(directory, "rolldown-binding.wasm32-wasi.wasm")),
    { headers: { ...headers, "Content-Type": "application/wasm" } });
  const name = path.endsWith("/wasi-worker-browser.mjs") ? "worker.js" : path.slice(1).replaceAll("/", "-");
  const file = Bun.file(join(scratch, name));
  return new Response(await file.exists() ? file : "Not found", { status: await file.exists() ? 200 : 404,
    headers: { ...headers, "Content-Type": "text/javascript" } });
} });

async function browserControl() {
  const phases: string[] = [];
  try {
    const loader = await import(new URL("./loader.js", globalThis.location.href).href);
    const binding = loader.default;
    phases.push("binding:return");
    const startedBytes = loader.probeMemories.map((memory: WebAssembly.Memory) => memory.buffer.byteLength);
    const input = "export const answer: number = 40 + 2;";
    const parsed = binding.parseSync("entry.ts", input);
    const transformed = binding.transformSync("entry.ts", input);
    const minified = binding.minifySync("entry.js", "globalThis.answer = 40 + 2;");
    if (parsed.errors.length || transformed.errors.length || minified.errors.length) throw new Error("Sync API error");
    const large = Array.from({ length: 8000 }, (_, index) => `globalThis.value${index} = ${index};`).join("\n");
    if (binding.transformSync("large.js", large).errors.length) throw new Error("Large input error");
    phases.push("sync:return");
    binding.startAsyncRuntime();
    const asynchronous = await binding.transform("entry.ts", input);
    if (JSON.stringify(asynchronous) !== JSON.stringify(transformed)) throw new Error("Async result differs");
    if ((await binding.parse("entry.ts", input)).program !== parsed.program) throw new Error("Async parser differs");
    if (JSON.stringify(await binding.minify("entry.js", "globalThis.answer = 40 + 2;")) !== JSON.stringify(minified)) throw new Error("Async minifier differs");
    phases.push("async:return");
    const grownBytes = loader.probeMemories.map((memory: WebAssembly.Memory) => memory.buffer.byteLength);
    await binding[Symbol.for("napi.rs.wasi.dispose")]();
    phases.push("dispose:return");
    globalThis.postMessage({ ok: true, phases, descriptors: loader.probeDescriptors, startedBytes, grownBytes,
      output: { transformed, minified }, isolation: globalThis.crossOriginIsolated });
  } catch (error) {
    globalThis.postMessage({ ok: false, phases, error: error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack } : String(error) });
  }
}

async function runMode(browser: import("playwright").Browser, mode: string) {
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    return await page.evaluate((mode: string) => new Promise(resolve => {
      const worker = new Worker(`/${mode}/control.js`, { type: "module" });
      const timeout = setTimeout(() => { worker.terminate(); resolve({ ok: false, error: "Control timed out" }); }, 45_000);
      worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); worker.terminate(); resolve({ ok: false, error: event.message }); };
    }), mode);
  } finally {
    await page.close();
  }
}

async function runBrowser(name: string, browserType: import("playwright").BrowserType) {
  const browser = await browserType.launch({ headless: true, env: { ...process.env, TMPDIR: scratch } });
  try {
    for (const mode of ["stock", "small"]) {
      controls.push({ browser: name, version: browser.version(), mode, control: await runMode(browser, mode) });
    }
  } finally {
    await browser.close();
  }
}

try {
  generated.push(adapted);
  const adaptedResult = Bun.spawnSync([adapter, original, adapted], { stdout: "pipe", stderr: "pipe" });
  assert.equal(adaptedResult.exitCode, 0, adaptedResult.stderr.toString());
  assert.equal(JSON.parse(adaptedResult.stdout.toString()).changed, true);
  assert.equal(readFileSync(adapted, "utf8"), readFileSync(original, "utf8").replace("initial: 16384,", "initial: 1001 ,"));
  const banner = "const probeMemories = [], probeDescriptors = []; const WebAssembly = Object.create(globalThis.WebAssembly); WebAssembly.Memory = class extends globalThis.WebAssembly.Memory { constructor(d) { super(d); probeDescriptors.push(d); probeMemories.push(this); } }; export { probeMemories, probeDescriptors };";
  for (const mode of ["stock", "small"]) {
    await build({ entryPoints: [mode === "stock" ? original : adapted], bundle: true, platform: "browser", format: "esm",
      outfile: join(scratch, `${mode}-loader.js`), banner: { js: banner } });
    writeFileSync(join(scratch, `${mode}-control.js`), `(${browserControl.toString()})();`);
  }
  await build({ entryPoints: [join(directory, "wasi-worker-browser.mjs")], bundle: true, platform: "browser", format: "esm",
    outfile: join(scratch, "worker.js") });
  await runBrowser("chromium", chromium);
  await runBrowser("webkit", webkit);
  for (const entry of controls) {
    const control = entry.control;
    assert(control && typeof control === "object" && "ok" in control && control.ok === true,
      `${entry.browser}/${entry.mode} failed; retained in ${result}`);
  }
} finally {
  server.stop(true);
  for (const path of generated) rmSync(path, { force: true });
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(result, JSON.stringify({ controls, removedScratch: scratch }, null, 2) + "\n");
}
