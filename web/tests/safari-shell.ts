// Run the built playground's actual Shell with a single WebDriver Ctrl+C key chord.
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { safariDriver, object } from "./safari-webdriver";

type Driver = Awaited<ReturnType<typeof safariDriver>>;
const directory = resolve(process.argv[2] ?? ".");
async function respond(request: Request) {
  const pathname = new URL(request.url).pathname;
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  if (pathname === "/cleanup.html") return new Response("<!doctype html><title>Safari cleanup</title>", { headers });
  const file = resolve(directory, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(directory + sep) || !await Bun.file(file).exists()) return new Response(null, { status: 404, headers });
  return new Response(Bun.file(file), { headers });
}
async function checkEngine(driver: Driver, origin: string, engine: string) {
  await driver.navigate(`${origin}/?engine=${engine}&prompt=off`);
  const ready = await driver.evaluate("const end=Date.now()+45000;while(!globalThis.playground||document.querySelector('#engine').disabled){if(Date.now()>end)throw Error('playground startup timed out');await new Promise(r=>setTimeout(r,25));}const p=globalThis.playground;globalThis.safariShellText=()=>Array.from({length:p.term.buffer.active.length},(_,i)=>p.term.buffer.active.getLine(i).translateToString()).join('\\n');return document.querySelector('#status').textContent;");
  const command = `bun -e 'require("node:fs").writeSync(2,"CPU_"+"READY\\n");for(;;){}'`;
  await driver.evaluate("const p=globalThis.playground;p.term.focus();globalThis.safariShellSubmission=p.shell.submit(arguments[0]);return true;", [command]);
  await driver.evaluate("const end=Date.now()+45000;while(!globalThis.safariShellText().includes('CPU_READY')){if(Date.now()>end)throw Error('CPU-bound guest did not start');await new Promise(r=>setTimeout(r,25));}return true;");
  await driver.controlC();
  const interrupted = object(await driver.evaluate("const p=globalThis.playground;await globalThis.safariShellSubmission;await new Promise(r=>setTimeout(r,100));return {running:p.shell.running,status:p.shell.lastExit,terminal:globalThis.safariShellText()};"));
  assert.equal(interrupted.status, 130, `${engine}: one Ctrl+C must return 130`);
  assert.equal(interrupted.running, false);
  assert.match(String(interrupted.terminal).trimEnd(), /(?:^|\n)\$$/);
  const recovered = object(await driver.evaluate("const p=globalThis.playground;await p.shell.submit('echo SHELL_\"RECOVERED\"');await new Promise(r=>setTimeout(r,100));return {status:p.shell.lastExit,text:globalThis.safariShellText()};"));
  assert.equal(recovered.status, 0); assert.match(String(recovered.text), /SHELL_RECOVERED/);
  return { engine, ready, ...interrupted, recovered };
}
export function assertShellConsumerResult(value: unknown) {
  const result = object(value);
  assert.ok(Array.isArray(result.results), "consumer results");
  const rows = result.results.map(object);
  assert.deepEqual(rows.map(row => row.name), ["lookup", "files-cwd-env-exit9", "epipe", "nested-stdin", "live-ticker", "binary", "interrupt", "preview"]);
  assert.ok(rows.every(row => row.ok === true), JSON.stringify(rows));
  return result;
}
async function checkConsumer(driver: Driver, origin: string) {
  await driver.navigate(`${origin}/`);
  const result = assertShellConsumerResult(await driver.evaluate("const end=Date.now()+30000;while(!globalThis.shellConsumer){if(Date.now()>end)throw Error('consumer startup timed out');await new Promise(r=>setTimeout(r,25));}return await globalThis.shellConsumer.exercise();"));
  const preview = await driver.evaluate("const frame=document.createElement('iframe');const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('preview timed out')),30000);frame.onload=()=>{clearTimeout(timer);resolve(frame.contentDocument.body.innerText);};});frame.src='/__preview/31976/';document.body.append(frame);return await loaded;");
  assert.equal(preview, "REAL_SHELL_PREVIEW", "shared service worker serves the real Bun preview");
  assert.deepEqual(object(await driver.evaluate("return globalThis.safariObservations;")).pageErrors, []);
  return { engine: "consumer", result, preview };
}
async function cleanupConsumer(driver: Driver) {
  const released = await driver.evaluate("return await globalThis.shellConsumer?.cleanup();");
  assert.deepEqual(released, { workers: 0, listeners: 0, pageListeners: 0, sessions: 0, borrowerPreservedUntilOwnerDisposal: true });
  return released;
}
async function clearWorkspace(driver: Driver, origin: string) {
  await driver.navigate(`${origin}/cleanup.html`);
  await driver.evaluate("for(const db of await indexedDB.databases()){await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(db.name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('database blocked'));});}const root=await navigator.storage.getDirectory();for await(const name of root.keys())await root.removeEntry(name,{recursive:true});for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister();for(const name of await caches.keys())await caches.delete(name);return true;");
}
async function recordConsumerCleanup(driver: Driver, rows: unknown[]) {
  try { rows.push({ engine: "consumer-cleanup", ok: true, released: await cleanupConsumer(driver) }); }
  catch (error) { rows.push({ engine: "consumer-cleanup", ok: false, error: String(error) }); process.exitCode = 1; }
}
async function cleanupResources(driver: Driver | undefined, servers: readonly ReturnType<typeof Bun.serve>[], cleanupErrors: string[]) {
  for (const server of servers) {
    if (!driver) continue;
    try { await clearWorkspace(driver, `http://127.0.0.1:${server.port}`); }
    catch (error) { cleanupErrors.push(String(error)); }
  }
  try { await driver?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  for (const server of servers) await server.stop(true);
  if (cleanupErrors.length) process.exitCode = 1;
}
async function run() {
  const rows: unknown[] = [], cleanupErrors: string[] = [];
  const servers: ReturnType<typeof Bun.serve>[] = [];
  let driver: Driver | undefined;
  let cleanupPromise: Promise<void> | undefined;
  function cleanup() { return cleanupPromise ??= cleanupResources(driver, servers, cleanupErrors); }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
  const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 8 * 60_000);
  async function check(engine: string) {
    assert.ok(driver);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond }); servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const result = engine === "consumer" ? await checkConsumer(driver, origin) : await checkEngine(driver, origin, engine);
      rows.push({ origin, ok: true, ...result });
    }
    catch (error) {
      rows.push({ engine, origin, ok: false, error: String(error), diagnostics: await driver.evaluate("return {text:globalThis.safariShellText?.(),running:globalThis.playground?.shell.running,status:globalThis.playground?.shell.lastExit};").catch(String) });
      process.exitCode = 1;
    }
    if (engine === "consumer") await recordConsumerCleanup(driver, rows);
    console.log(JSON.stringify(rows));
  }
  let capabilities: unknown;
  try {
    driver = await safariDriver(); capabilities = driver.capabilities;
    for (const engine of process.env.SAFARI_SHELL_CONSUMER === "1" ? ["consumer"] : ["quickjs", "jsc", "browser"]) await check(engine);
  } finally {
    clearTimeout(deadline); await cleanup();
    const report = { capabilities, rows, cleanup: { ok: cleanupErrors.length === 0, errors: cleanupErrors } };
    if (process.env.SAFARI_OUTPUT) await Bun.write(process.env.SAFARI_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  }
}
if (import.meta.main) await run();
