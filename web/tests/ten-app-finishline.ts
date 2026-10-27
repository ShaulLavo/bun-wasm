import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import type { ProductApi } from "../../tests/shell-product/protocol.ts";
import { recipe } from "../../tests/ten-app-finishline/recipes.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { acceptedGuest, createFinishlineRun, openRegistry, runMode, networkSnapshot } from "../../tests/ten-app-finishline/acceptance.ts";
import { bounded } from "../../tests/shell-product/lifecycle.ts";
import { browserRegistryRoute, registryBrokerResponse } from "../../scripts/app-matrix/registry-request.ts";
import { buildClassicWorker } from "../../scripts/browser-build.ts";
import { bundleProduct } from "./browser-shell-product-install.ts";

declare global {
  var shellProduct: ProductApi;
  var tenApp: { prepareModules(): Promise<void>; editFile(path: string, source: string): Promise<void>; stop(): Promise<{ code: number; output: string }> };
}
const fixture = recipe(process.argv[2] ?? "");
const root = resolve(import.meta.dir, "../..");
const requestedReports = process.env.TEN_APP_REPORT;
const installation = process.env.SHELL_PRODUCT_INSTALL;
const corpus = process.env.SHELL_PRODUCT_REGISTRY;
assert(requestedReports && isAbsolute(requestedReports), "Set absolute TEN_APP_REPORT");
const reports = requestedReports;
let mode: ReturnType<typeof runMode> = "acceptance";
let scratch: string | undefined;
let creatingScratch: Promise<string> | undefined;
let preparingFiles: Promise<unknown> | undefined;
let launching: Promise<Browser> | undefined;
let openingMirror: ReturnType<typeof openRegistry> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let mirror: Awaited<ReturnType<typeof openRegistry>> | undefined;
let broker: ReturnType<typeof Bun.serve> | undefined;
const rows: object[] = [];
const external: string[] = [];
function save(name: string, value: unknown) {
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, name), JSON.stringify(value, null, 2)+"\n");
}
function snapshot() {
  networkSnapshot(mirror, external, save);
}
const run = createFinishlineRun({
  snapshot,
  report: failure => save("failure.json", failure),
  cleanup: {
    captureTimeout: 1000,
    capture: async () => {
      if (!page || page.isClosed()) return;
      const terminal = await bounded(page.evaluate(() => shellProduct?.diagnostics()), 400, "terminal capture").catch(String);
      save("terminal.json", terminal);
      const product = await bounded(page.evaluate(() => shellProduct?.cleanup()), 400, "product cleanup");
      save("product-cleanup.json", product);
    },
    closeBrowser: async () => { await (browser ?? await launching?.catch(() => undefined))?.close(); },
    stopServer: async () => {
      const results = await Promise.allSettled([Promise.resolve().then(() => server?.stop(true)), Promise.resolve().then(() => broker?.stop(true))]);
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Asset server or recorder broker stop failed");
    },
    closeMirror: async () => { await (mirror ?? await openingMirror?.catch(() => undefined))?.close(); },
    removeScratch: async () => {
      await preparingFiles?.catch(() => undefined);
      const directory = scratch ?? await creatingScratch?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  },
});
async function stage(name: string, execute: () => Promise<unknown>) {
  try {
    const result = await execute();
    rows.push({ name, status: mode === "acceptance" ? "pass" : "prepared", result });
    console.log(name, mode === "acceptance" ? "PASS" : "PREPARED");
  } catch (error) {
    run.fail(error);
    rows.push({ name, status: "fail", error: String(error) });
    try { save("results.json", rows); } catch (reportError) { run.fail(reportError); }
    throw error;
  }
  save("results.json", rows);
}
async function command(text: string) {
  assert(page);
  const result = await page.evaluate(text => shellProduct.command(text, 90000), text);
  assert.equal(result.code, 0, result.output);
  return result;
}
async function preview(expected: string) {
  assert(page);
  const preview = await page.context().newPage();
  try {
    preview.on("console", message => console.log("preview", message.type(), message.text()));
    preview.on("pageerror", error => console.error("preview", error));
    const response = await preview.goto(new URL("__preview/3137/", page.url()).href);
    save("last-page.json", { url: preview.url(), status: response?.status(), body: await preview.content() });
    assert(response); assert(response.fromServiceWorker()); assert.equal(response.status(),200);
    await preview.locator(fixture.selector).filter({ hasText:expected }).waitFor({timeout:90000});
    return await preview.locator(fixture.selector).innerText();
  } catch (error) { run.fail(error); throw error; }
  finally { await preview.close().catch(error => run.fail(error)); }
}
async function interrupt() {
  assert(page);
  const before: unknown = await page.evaluate(() => Reflect.get(shellProduct.diagnostics(), "listeners"));
  assert.deepEqual(before,[3137]);
  await page.locator("#terminal-input").focus();
  await page.keyboard.press("Control+c");
  const result = await page.evaluate(() => tenApp.stop());
  assert([0,130].includes(result.code));
  const after: unknown = await page.evaluate(() => Reflect.get(shellProduct.diagnostics(), "listeners"));
  assert.deepEqual(after,[]);
  const prompt = await command("echo TEN_PROMPT_USABLE");
  assert(prompt.output.split(/\r?\n/).includes("TEN_PROMPT_USABLE"));
  return {before,after,result,prompt};
}
async function prepareFiles(directory: string, preparedInstallation: string) {
  const staging = join(directory, "source");
  const sources = join(staging,"tests/shell-product");
  await cp(join(root,"tests/shell-product"),sources,{recursive:true});
  const main = join(sources,"main.ts");
  await cp(join(root,"web/src/sw.ts"),join(sources,"module-sw.ts"));
  const scopedMain = (await readFile(main,"utf8")).replace('workerUrl: new URL("./worker.js", location.href)', 'workerUrl: new URL("./__bunwasm/worker.js", location.href)');
  await writeFile(main,scopedMain+`
const terminalInput = document.createElement('textarea'); terminalInput.id = 'terminal-input'; document.body.append(terminalInput);
let stopPromise;
terminalInput.addEventListener('keydown', event => { if (!event.ctrlKey || event.key.toLowerCase() !== 'c') return; event.preventDefault(); stopPromise = shellProduct.interrupt(); });
Reflect.set(globalThis, 'tenApp', { prepareModules: async () => { const registration = await navigator.serviceWorker.register('./module-sw.js', { scope: './__bunwasm/' }); await activated(registration); }, editFile: async (path, source) => { await write(path, source); await runtime.filesystem.flush(); }, stop: () => stopPromise });
`);
  const output=join(directory,"dist");
  const inputs=await bundleProduct(staging,preparedInstallation,output);
  await buildClassicWorker(join(inputs.app,"module-sw.ts"),output,undefined,join(inputs.app,"main.ts"));
  return { inputs, output };
}
async function execute() {
  mode = runMode(process.argv.slice(3));
  const accepted = await acceptedGuest(process.env);
  run.check();
  save("inputs.json", { mode, guestArtifact: accepted.artifact, acceptedReceipt: accepted.accepted, guestSource: accepted.source, guestProvenance: accepted.provenance });
  assert(installation && isAbsolute(installation), "Set absolute SHELL_PRODUCT_INSTALL");
  const preparedInstallation = installation;
  const prefix = process.env.TEN_APP_SCRATCH ?? "/work/tmp/bw-ten-";
  assert(isAbsolute(prefix), "TEN_APP_SCRATCH must be absolute");
  creatingScratch = mkdtemp(prefix);
  scratch = await creatingScratch;
  run.check();
  const preparing = prepareFiles(scratch, preparedInstallation);
  preparingFiles = preparing;
  const { inputs, output } = await preparing;
  run.check();
  save("inputs.json", { ...inputs, mode, guestArtifact: accepted.artifact, acceptedReceipt: accepted.accepted, guestSource: accepted.source, guestProvenance: accepted.provenance });
  assert(corpus && isAbsolute(corpus), "Set absolute SHELL_PRODUCT_REGISTRY");
  if (mode === "prepare-registry") {
    const socket=join(scratch,"registry.sock");
    broker=Bun.serve({unix:socket,fetch:registryBrokerResponse});
    process.env.MATRIX_RECORDER_SOCKET=socket;
  }
  openingMirror = openRegistry(corpus, mode);
  mirror = await openingMirror;
  run.check();
  server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const path = new URL(request.url).pathname;
    const headers={"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cache-Control":"no-store"};
    if(path==="/bun-guest.wasm") return new Response(accepted.bytes,{headers:{...headers,"Content-Type":"application/wasm"}});
    const file=resolve(output,`.${path==="/"?"/index.html":path}`);
    if(!file.startsWith(output+sep)||!await Bun.file(file).exists())return new Response(null,{status:404,headers});
    return new Response(Bun.file(file),{headers});
  }});
  const {chromium}=await import(pathToFileURL(join(preparedInstallation,"node_modules/playwright/index.mjs")).href);
  run.check();
  launching = chromium.launch({headless:true, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch }});
  browser=await launching; assert(browser);
  run.check();
  const context=await browser.newContext(); const base=mirror.base;
  await context.route("**/*",route=>browserRegistryRoute(route,base,external));
  page=await context.newPage(); page.on("console",m=>console.log("browser",m.type(),m.text())); page.on("pageerror",e=>console.error(e));
  await page.goto(`http://127.0.0.1:${server.port}/`); await page.waitForFunction(()=>Boolean(globalThis.shellProduct));
  await page.evaluate(()=>tenApp.prepareModules());
  await page.evaluate(()=>shellProduct.setup());
  await page.evaluate(({fixture,base})=>shellProduct.open(fixture,base),{fixture,base});
  if (mode === "prepare-registry") {
    await stage("prepare-registry", () => command("bun install"));
    return;
  }
  await runApplication();
}
async function runApplication() {
  await stage("install",()=>command("bun install"));
  await stage("dev",async()=>{assert(page);await page.evaluate(()=>shellProduct.start("bun run dev",3137,90000));return preview(fixture.text);});
  const edited=`${fixture.text} EDITED`;
  await stage("edit-reload",async()=>{
    assert(page);
    const file=`/home/guest/${fixture.id}/${fixture.editPath}`;
    const source=await page.evaluate(file=>shellProduct.readFile(file),file);assert(source);
    const offset=await page.evaluate(()=>shellProduct.diagnostics().transcripts.map(row=>row.text).join("").length);
    await page.evaluate(({file,source})=>tenApp.editFile(file,source),{file,source:source.replace(fixture.text,edited)});
    await page.waitForFunction(offset=>/page reload|hmr update/.test(shellProduct.diagnostics().transcripts.map(row=>row.text).join("").slice(offset)),offset,{timeout:90000});
    return preview(edited);
  });
  await stage("dev-ctrl-c",interrupt);
  await stage("build",async()=>{const result=await command("bun run build");assert(page);for(const path of fixture.buildOutputs) assert(await page.evaluate(path=>shellProduct.readFile(path),`/home/guest/${fixture.id}/${path}`));return result;});
  await stage("built-page",async()=>{assert(page);await page.evaluate(()=>shellProduct.start("bun run start",3137,90000));return preview(edited);});
  await stage("ctrl-c",interrupt);
}
process.exitCode = await run.run(execute);
