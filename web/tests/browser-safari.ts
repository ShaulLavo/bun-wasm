// PC: source env.sh && bun web/tests/browser-safari.ts --build /work/tmp/bun-wasm-safari-<id>
// Reserved Mac: BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT=1 bun runner.mjs --run <copied directory>
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildBrowserEntries } from "../../scripts/browser-build";
import { runtimeProcChecks, runtimeProcJobWaitChecks } from "./runtime-proc-fixtures";
import { bunRuntimeProcScenarios } from "./bun-runtime-proc-fixtures";
import { assertBunRuntimeProcDiagnostics } from "./bun-runtime-proc-diagnostics";
import { BUN_WASM_ASSET } from "../../src/guest-asset.generated";
import { object, safariDriver } from "./safari-webdriver";
import { assertEngineInterruptionResult } from "./engine-interruption-result";

type Driver = Awaited<ReturnType<typeof safariDriver>>;
const action = process.argv[2], directory = resolve(process.argv[3] ?? ".");
const fixtures = [
  ["process", "process-browser-main"], ["runtime-proc", "runtime-proc-browser-main"],
  ["bun-runtime-proc", "bun-runtime-proc-main"], ["persistence", "persistence-browser-main"],
  ["engine", "engine-interruption-page"],
] as const;
async function build() {
  await mkdir(directory, { recursive: true });
  const root = resolve(import.meta.dir, "../..");
  for (const [folder, entry] of fixtures) {
    const out = join(directory, folder);
    await buildBrowserEntries([join(import.meta.dir, `${entry}.ts`), join(root, "web/src/worker.ts"),
      join(root, "web/src/fs-worker.ts"), join(import.meta.dir, "safari-observers.ts"),
      join(import.meta.dir, "safari-open-descriptor-worker.ts"), join(import.meta.dir, "engine-interruption-worker.ts")], out, { runtimeWorker: true });
    await Bun.write(join(out, "index.html"), `<!doctype html><script src="./safari-observers.js"></script><script type="module" src="./${entry}.js"></script>`);
  }
  const runner = await Bun.build({ entrypoints: [import.meta.filename], outdir: directory, target: "bun", format: "esm", naming: "runner.mjs" });
  assert.equal(runner.success, true, runner.logs.map(String).join("\n"));
  const shell = await Bun.build({ entrypoints: [join(import.meta.dir, "safari-shell.ts")], outdir: directory, target: "bun", format: "esm", naming: "shell-runner.mjs" });
  assert.equal(shell.success, true, shell.logs.map(String).join("\n"));
}
async function observations(driver: Driver) { return object(await driver.evaluate("return globalThis.safariObservations;")); }
async function checkProcess(driver: Driver, origin: string) {
  await driver.navigate(`${origin}/process/`);
  const result = await driver.result("processResult");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Array.isArray(result.checks)); assert.equal(result.checks.length, 23);
  assert.deepEqual((await observations(driver)).pageErrors, []);
  return result;
}
async function checkRuntimeProc(driver: Driver, origin: string, scenario: string, mode: string) {
  await driver.navigate(`${origin}/runtime-proc/?slots=off${mode === "explicit" ? "&explicit=1" : ""}${scenario === "job-wait" ? "&job-wait=1" : ""}`);
  const result = await driver.result("runtimeProcResult", 40_000);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks, Array.from(scenario === "job-wait" ? runtimeProcJobWaitChecks : runtimeProcChecks));
  assert.deepEqual(result.stopCodes, scenario === "pipes" ? [130, 137] : []);
  assert.equal(object(result.cleanup).activeWorkers, 0);
  assert.equal(object(result.teardown).forcedWorkers, 0);
  assert.equal(object(result.teardown).activeWorkers, 0);
  assert.equal(object(result.teardown).error ?? undefined, undefined);
  const observed = await observations(driver);
  assert.deepEqual(observed.pageErrors, []); assert.deepEqual(observed.consoleErrors, []);
  return result;
}
async function checkBun(driver: Driver, origin: string, scenario: string) {
  const published = process.env.BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT === "1";
  assert.ok(published || process.env.BUN_WASM_RUNTIME_PROC_ARTIFACT, "Select the published guest or an explicit current-main artifact");
  assert.ok(BUN_WASM_ASSET);
  const asset = BUN_WASM_ASSET;
  await driver.navigate(`${origin}/bun-runtime-proc/?engine=browser&scenario=${encodeURIComponent(scenario)}${published ? "&published-default" : ""}`);
  const result = await driver.result("bunRuntimeProcResult");
  const observed = await observations(driver);
  assert.ok(Array.isArray(observed.requests)); assert.ok(Array.isArray(observed.pageErrors)); assert.ok(Array.isArray(observed.consoleErrors));
  const guestRequests = observed.requests.filter(url => url === asset.core.url || String(url).endsWith("/bun-guest.wasm"));
  const expected = scenario === "generic-control" || published && scenario === "start-failed" ? [] : [published ? asset.core.url : `${origin}/bun-runtime-proc/bun-guest.wasm`];
  assert.deepEqual(guestRequests, expected, "guest request count matches eager local or lazy published loading");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(object(result.cleanup).activeWorkers, 0);
  assert.equal(object(result.teardown).forcedWorkers, 0);
  assert.equal(object(result.teardown).activeWorkers, 0);
  assert.equal(object(result.teardown).error ?? undefined, undefined);
  assertBunRuntimeProcDiagnostics(scenario, observed.pageErrors.map(String), observed.consoleErrors.map(String));
  return { ...result, guestRequests };
}
async function checkPersistence(driver: Driver, origin: string, storage: string) {
  const name = `bun-wasm-safari-${crypto.randomUUID()}`;
  await driver.navigate(`${origin}/persistence/`);
  await driver.evaluate("while(!globalThis.persistenceHarness)await new Promise(r=>setTimeout(r,25));return true;");
  try {
    const before = await driver.evaluate(`const h=globalThis.persistenceHarness;await h.open(arguments[0],true,arguments[1]);await h.mkdir('/tree');await h.write('/tree/original.bin',[0,255,1,0,128]);await h.write('/deleted.bin',[9,8,7]);await h.move('/tree/original.bin','/renamed.bin');await h.remove('/deleted.bin');await h.flush();return await h.snapshot();`, [name, storage]);
    const unlinked = await driver.evaluate("return await globalThis.persistenceHarness.unlinkWhileOpen();");
    assert.deepEqual(unlinked, { count: 5, bytes: [0, 255, 1, 0, 128] });
    assert.ok(Array.isArray(before)); assert.equal(before.length, 1);
    await driver.reload();
    const after = await driver.evaluate("while(!globalThis.persistenceHarness)await new Promise(r=>setTimeout(r,25));const h=globalThis.persistenceHarness;await h.open(arguments[0],true,arguments[1]);return await h.snapshot();", [name, storage]);
    assert.deepEqual(after, before, "reload preserves bytes, inode, mtime, rename and unlink");
    assert.deepEqual((await observations(driver)).pageErrors, []);
    return { before, after, unlinked };
  } finally {
    await driver.evaluate("await globalThis.persistenceHarness?.destroy();return true;");
  }
}
const runtimeCases = ["pipes", "job-wait"].flatMap(scenario => ["automatic", "explicit"].map(mode => ({ scenario, mode })));
export function selectSafariCaseNames(options: { prefix?: string; guestDirectory?: string; publishedDefault: boolean }) {
  if (options.prefix && "engine-interruption".startsWith(options.prefix)) {
    assert.ok(options.guestDirectory, "engine-interruption requires SAFARI_GUEST_DIR");
  }
  const names = ["artifact-free-process"].concat(
    runtimeCases.map(({ scenario, mode }) => `runtime-proc/${scenario}/${mode}`),
    ["generic-control"].concat(bunRuntimeProcScenarios.map(row => row.name)).map(scenario => `${options.publishedDefault ? "published" : "current"}-bun/${scenario}`),
    options.guestDirectory ? ["engine-interruption"] : [],
    ["persistence/indexeddb", "persistence/opfs"],
  );
  const selected = names.filter(name => !options.prefix || name.startsWith(options.prefix));
  assert.ok(selected.length > 0, `SAFARI_CASE matched no scenarios: ${options.prefix}`);
  return selected;
}
export function assertSafariCaseRows(rows: readonly { name: string }[], selected: readonly string[]) {
  assert.ok(rows.length > 0, "Safari gate executed no scenarios");
  assert.deepEqual(rows.map(row => row.name), selected, "every selected Safari scenario executed once");
}
async function clearOrigin(driver: Driver, server: ReturnType<typeof Bun.serve>) {
  await driver.navigate(`http://127.0.0.1:${server.port}/__safari-empty.html`);
  await driver.evaluate("for(const db of await indexedDB.databases()){await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(db.name);r.onsuccess=resolve;r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('database cleanup blocked'));});}const root=await navigator.storage.getDirectory();for await(const name of root.keys())await root.removeEntry(name,{recursive:true});return true;");
}
async function cleanupResources(driver: Driver | undefined, servers: readonly ReturnType<typeof Bun.serve>[]) {
  const errors: unknown[] = [];
  for (const server of servers) {
    if (!driver) continue;
    try { await clearOrigin(driver, server); } catch (error) { errors.push(error); }
  }
  try { await driver?.close(); } catch (error) { errors.push(error); }
  for (const server of servers) {
    try { await server.stop(true); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, `Safari cleanup failed: ${errors.map(String).join("; ")}`);
}
async function run() {
  const selected = selectSafariCaseNames({ prefix: process.env.SAFARI_CASE, guestDirectory: process.env.SAFARI_GUEST_DIR,
    publishedDefault: process.env.BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT === "1" });
  const report: { capabilities?: unknown; rows: { name: string; ok: boolean; result?: unknown; error?: string; diagnostics?: unknown }[]; cleanup?: unknown } = { rows: [] };
  let driver: Driver | undefined;
  const servers: ReturnType<typeof Bun.serve>[] = [];
  async function respond(request: Request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/__safari-empty.html") return new Response("<!doctype html><title>Safari cleanup</title>", { headers });
    const guestDirectory = process.env.SAFARI_GUEST_DIR;
    if (guestDirectory && ["/bun.wasm", "/bun-jsc.wasm", "/bun-browser.wasm"].includes(pathname)) return new Response(Bun.file(join(guestDirectory, pathname.slice(1))), { headers });
    const artifact = process.env.BUN_WASM_RUNTIME_PROC_ARTIFACT;
    if (pathname === "/bun-runtime-proc/bun-guest.wasm" && artifact) return new Response(Bun.file(artifact), { headers });
    const path = resolve(directory, `.${pathname.endsWith("/") ? pathname + "index.html" : pathname}`);
    if (!path.startsWith(directory + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  }
  function serve() {
    // Playwright's newPage isolates storage; Safari needs a separate run-owned origin per case.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
    servers.push(server); return server;
  }
  let cleanupPromise: Promise<void> | undefined;
  function cleanup() { return cleanupPromise ??= cleanupResources(driver, servers); }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
  const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 45 * 60_000);
  async function check(name: string, test: (owned: Driver, origin: string) => Promise<unknown>) {
    if (!selected.includes(name)) return;
    assert.ok(driver);
    const server = serve();
    try { report.rows.push({ name, ok: true, result: await test(driver, `http://127.0.0.1:${server.port}`) }); }
    catch (error) { report.rows.push({ name, ok: false, error: String(error), diagnostics: await driver.evaluate("return {observations:globalThis.safariObservations,process:globalThis.processResult,progress:globalThis.processProgress?.(),engine:globalThis.engineInterruptionProgress?.(),runtime:globalThis.runtimeProcDiagnostics?.(),bun:globalThis.bunRuntimeProcDiagnostics?.()};").catch(String) }); }
    console.log(JSON.stringify(report.rows.at(-1)));
  }
  try {
    driver = await safariDriver(); report.capabilities = driver.capabilities;
    console.log(JSON.stringify({ capabilities: driver.capabilities, driver: driver.pid }));
    await check("artifact-free-process", checkProcess);
    for (const { scenario, mode } of runtimeCases) await check(`runtime-proc/${scenario}/${mode}`, (d, o) => checkRuntimeProc(d, o, scenario, mode));
    for (const scenario of ["generic-control"].concat(bunRuntimeProcScenarios.map(row => row.name))) await check(`${process.env.BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT === "1" ? "published" : "current"}-bun/${scenario}`, (d, o) => checkBun(d, o, scenario));
    if (process.env.SAFARI_GUEST_DIR) await check("engine-interruption", async (d, o) => {
      await d.navigate(`${o}/engine/`);
      const result = await d.result("engineInterruptionResult", 650_000);
      assertEngineInterruptionResult({ ...result, pageErrors: (await observations(d)).pageErrors }, false);
      return result;
    });
    for (const storage of ["indexeddb", "opfs"]) await check(`persistence/${storage}`, (d, o) => checkPersistence(d, o, storage));
  } finally {
    clearTimeout(deadline);
    try { await cleanup(); report.cleanup = { sessionClosed: true, driverStopped: true, listenerStopped: true }; }
    catch (error) { report.cleanup = { ok: false, error: String(error) }; process.exitCode = 1; }
    if (process.env.SAFARI_OUTPUT) await Bun.write(process.env.SAFARI_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  }
  assertSafariCaseRows(report.rows, selected);
  if (report.rows.some(row => !row.ok)) process.exitCode = 1;
}
if (import.meta.main) {
  if (action === "--build") await build();
  else { assert.equal(action, "--run", "Use --build <directory> or --run <directory>"); await run(); }
}
