import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import type { ProductApi } from "../../tests/shell-product/protocol.ts";
import { recipe } from "../../tests/ten-app-finishline/recipes.ts";
import { registry } from "../../scripts/app-matrix/registry.mjs";
import { browserRegistryRoute, registryBrokerResponse } from "../../scripts/app-matrix/registry-request.ts";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { buildClassicWorker } from "../../scripts/browser-build.ts";
import { bundleProduct } from "./browser-shell-product-install.ts";

declare global {
  var shellProduct: ProductApi;
  var tenApp: { prepareModules(): Promise<void>; editFile(path: string, source: string): Promise<void>; stop(): Promise<{ code: number; output: string }> };
}
const fixture = recipe(process.argv[2] ?? "");
const root = resolve(import.meta.dir, "../..");
const reports = process.env.TEN_APP_REPORT;
const installation = process.env.SHELL_PRODUCT_INSTALL;
const artifact = process.env.SHELL_PRODUCT_GUEST;
const corpus = process.env.SHELL_PRODUCT_REGISTRY;
assert(reports && installation && artifact && corpus, "Set report, installation, guest and private registry paths");
const bytes = await Bun.file(artifact).bytes();
verifyGuestBuildReceipt(bytes, await Bun.file(`${artifact}.build.json`).json());
await mkdir(reports, { recursive: true });
const scratch = await mkdtemp(process.env.TEN_APP_SCRATCH ?? "/work/tmp/bw-ten-");
let browser: Browser | undefined;
let page: Page | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let mirror: Awaited<ReturnType<typeof registry>> | undefined;
let broker: ReturnType<typeof Bun.serve> | undefined;
const rows: object[] = [];
const external: string[] = [];
const save = (name: string, value: unknown) => Bun.write(join(reports, name), JSON.stringify(value, null, 2)+"\n");
async function stage(name: string, execute: () => Promise<unknown>) {
  try { const result = await execute(); rows.push({ name, status: "pass", result }); console.log(name, "PASS"); }
  catch(error) { rows.push({ name, status: "fail", error:String(error) }); throw error; }
  finally { await save("results.json", rows); }
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
    await save("last-page.json", { url: preview.url(), status: response?.status(), body: await preview.content() });
    assert(response); assert(response.fromServiceWorker()); assert.equal(response.status(),200);
    await preview.locator(fixture.selector).filter({ hasText:expected }).waitFor({timeout:90000});
    return await preview.locator(fixture.selector).innerText();
  } finally { await preview.close(); }
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
async function cleanup() {
  try { if(page) await page.evaluate(() => shellProduct?.cleanup()).then(value=>save("product-cleanup.json",value)); }
  finally {
    await browser?.close(); server?.stop(true); await mirror?.close(); await broker?.stop(true);
    await rm(scratch,{recursive:true,force:true});
  }
}
const onSignal = () => void cleanup().finally(()=>process.exit(130));
for(const signal of ["SIGINT","SIGTERM"] as const) process.once(signal,onSignal);
try {
  const staging = join(scratch,"source");
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
  const output=join(scratch,"dist");
  const inputs=await bundleProduct(staging,installation,output); await save("inputs.json",inputs);
  await buildClassicWorker(join(inputs.app,"module-sw.ts"),output,undefined,join(inputs.app,"main.ts"));
  const socket=join(scratch,"registry.sock");
  broker=Bun.serve({unix:socket,fetch:registryBrokerResponse}); process.env.MATRIX_RECORDER_SOCKET=socket;
  mirror=await registry({directory:corpus,record:true});
  server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const path = new URL(request.url).pathname;
    const headers={"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cache-Control":"no-store"};
    if(path==="/bun-guest.wasm") return new Response(bytes,{headers:{...headers,"Content-Type":"application/wasm"}});
    const file=resolve(output,`.${path==="/"?"/index.html":path}`);
    if(!file.startsWith(output+sep)||!await Bun.file(file).exists())return new Response(null,{status:404,headers});
    return new Response(Bun.file(file),{headers});
  }});
  const {chromium}=await import(pathToFileURL(join(installation,"node_modules/playwright/index.mjs")).href);
  browser=await chromium.launch({headless:true}); assert(browser);
  const context=await browser.newContext(); const base=mirror.base;
  await context.route("**/*",route=>browserRegistryRoute(route,base,external));
  page=await context.newPage(); page.on("console",m=>console.log("browser",m.type(),m.text())); page.on("pageerror",e=>console.error(e));
  await page.goto(`http://127.0.0.1:${server.port}/`); await page.waitForFunction(()=>Boolean(globalThis.shellProduct));
  await page.evaluate(()=>tenApp.prepareModules());
  await page.evaluate(()=>shellProduct.setup());
  await page.evaluate(({fixture,base})=>shellProduct.open(fixture,base),{fixture,base});
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
  assert.deepEqual(external,[]); await save("registry.json",mirror.snapshot());
} catch(error) {
  console.error(error);process.exitCode=1;
} finally {
  if(page) await save("terminal.json",await page.evaluate(()=>shellProduct?.diagnostics()).catch(String));
  await cleanup();
  for(const signal of ["SIGINT","SIGTERM"] as const) process.off(signal,onSignal);
}
