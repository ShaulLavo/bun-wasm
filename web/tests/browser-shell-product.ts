import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt";
import { registry } from "../../scripts/app-matrix/registry.mjs";
import { browserRegistryRoute } from "../../scripts/app-matrix/registry-request";
import { fixtures, stages, type Fixture, type Row, type Stage } from "../../tests/shell-product/fixtures";
import type { ProductApi } from "../../tests/shell-product/protocol";
import { bundleProduct } from "./browser-shell-product-install";

declare global { var shellProduct: ProductApi; }
const root = resolve(import.meta.dir, "../..");
const reports = resolve(process.env.SHELL_PRODUCT_REPORTS ?? "/work/reports/wave-20261022/waffle/r2/shell-product-r318");
const timeout = Number(process.env.SHELL_PRODUCT_TIMEOUT_MS ?? 90000);
assert.ok(Number.isFinite(timeout) && timeout > 0, "Positive stage deadline required");
const rows: Row[] = [];
let scratch: string | undefined;
let app: string | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let mirror: Awaited<ReturnType<typeof registry>> | undefined;
let cleanupPromise: Promise<void> | undefined;
let page: Page | undefined;
let activeURL: string | undefined;
const external: string[] = [];
await mkdir(reports, { recursive: true });
async function save() { await Bun.write(join(reports, "scoreboard.json"), JSON.stringify(rows, null, 2) + "\n"); }
async function record(row: Row) { rows.push(row); console.log(JSON.stringify(row)); await save(); }
function message(error: unknown) { return error instanceof Error ? error.stack ?? error.message : String(error); }
async function stage(fixture: Fixture, name: Stage, execute: () => Promise<string>, blocked?: string) {
  if (blocked) { await record({ app: fixture.id, stage: name, status: "blocked", detail: blocked }); return false; }
  try { await record({ app: fixture.id, stage: name, status: "pass", detail: await execute() }); return true; }
  catch (error) { await record({ app: fixture.id, stage: name, status: "fail", detail: message(error) }); return false; }
  finally { await capture(); }
}
async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), milliseconds); });
  try { return await Promise.race([promise, expired]); }
  finally { clearTimeout(timer); }
}
async function capture() {
  if (!page || page.isClosed()) return;
  const diagnostics = await bounded(page.evaluate(() => globalThis.shellProduct?.diagnostics()), 3000, "terminal capture").catch(error => ({ error: message(error) }));
  await Bun.write(join(reports, "terminal.json"), JSON.stringify(diagnostics, null, 2));
}
async function cleanup() {
  return cleanupPromise ??= (async () => {
    await capture();
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { await removeHostResources(); }
  })();
}
async function removeHostResources() {
  try { await server?.stop(true); await mirror?.close(); }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
async function portOpen(port: number) {
  return Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(130)));
const deadline = setTimeout(() => { console.error("Shell product overall deadline"); void cleanup().finally(() => process.exit(1)); }, 20 * 60000);
async function command(text: string, expected?: string) {
  assert.ok(page);
  const result = await page.evaluate(({ text, timeout }) => globalThis.shellProduct.command(text, timeout), { text, timeout });
  assert.equal(result.code, 0, `${text}\n${result.output}`);
  if (expected) assert.ok(result.output.split(/\r?\n/).includes(expected), `Missing output line ${expected}: ${result.output}`);
  return `${text}\n${result.output}`;
}
async function dev(fixture: Fixture, text: string, port = 3137) {
  assert.ok(page && browser);
  const url = await page.evaluate(({ text, port, timeout }) => globalThis.shellProduct.start(text, port, timeout), { text, port, timeout });
  activeURL = url;
  const preview = await page.context().newPage();
  try {
    const response = await preview.goto(url, { timeout });
    assert.ok(response, "Preview response required");
    assert.ok(response.fromServiceWorker(), "Preview must be delivered by the actual service worker");
    assert.equal(response.status(), 200);
    await preview.locator(fixture.selector).filter({ hasText: fixture.text }).waitFor({ timeout });
    await preview.screenshot({ path: join(reports, `${fixture.id}-${port}-${rows.length}.png`) });
    return `${text}: service-worker HTTP 200; loaded DOM ${fixture.selector} contains ${fixture.text}`;
  } finally { await preview.close(); }
}
async function interrupt() {
  assert.ok(page);
  const result = await page.evaluate(() => globalThis.shellProduct.interrupt());
  await stoppedPreview();
  const output = await command("echo PROMPT_USABLE", "PROMPT_USABLE");
  return `Ctrl-C status ${result.code}; guest listener removed; ${output}`;
}
async function stoppedPreview() {
  assert.ok(page);
  if (!activeURL) return;
  const preview = await page.context().newPage();
  try {
    const response = await preview.goto(activeURL, { timeout });
    assert.ok(response?.fromServiceWorker(), "Stopped preview still uses service worker");
    assert.equal(response?.status(), 502, "Stopped guest cannot answer HTTP requests");
    activeURL = undefined;
  } finally { await preview.close(); }
}
async function stopAfterFailure() {
  if (!page) return;
  const pending = await page.evaluate(() => Boolean(globalThis.shellProduct.diagnostics().pending));
  if (pending) await page.evaluate(() => globalThis.shellProduct.interrupt());
}
async function missingStages(fixture: Fixture) {
  for (const name of stages) {
    if (rows.some(row => row.app === fixture.id && row.stage === name)) continue;
    await record({ app: fixture.id, stage: name, status: "blocked", detail: "Earlier setup or session failure; see raw log and terminal.json" });
  }
}
async function runCycle(fixture: Fixture, [start, stop, text]: readonly [Stage, Stage, string], installed: boolean, available: boolean) {
  assert.ok(page);
  const blocked = !installed ? "Guest install failed" : !available ? "Previous stop failed" : undefined;
  await stage(fixture, start, () => dev(fixture, text), blocked);
  const pending = await page.evaluate(() => Boolean(globalThis.shellProduct.diagnostics().pending));
  const stopped = await stage(fixture, stop, interrupt, blocked ?? (!pending ? "Server returned to prompt before Ctrl-C" : undefined));
  return blocked ? available : !pending || stopped;
}
async function runFixture(fixture: Fixture) {
  try { await runApp(fixture); }
  catch (error) { await record({ app: fixture.id, stage: "session", status: "fail", detail: message(error) }); }
  finally { await capture(); await missingStages(fixture); await page?.evaluate(() => globalThis.shellProduct.close()).catch(error => console.error(message(error))); }
}
async function runApp(fixture: Fixture) {
  assert.ok(page && mirror);
  await page.evaluate(({ fixture, base }) => globalThis.shellProduct.open(fixture, base), { fixture, base: mirror.base });
  const installed = await stage(fixture, "install", () => command("bun install"));
  let available = true;
  const cycles: readonly [Stage, Stage, string][] = [["install-and-dev-dom", "ctrl-c-1", "bun install && bun run dev"], ["restart-2-dom", "ctrl-c-2", "bun run dev"], ["restart-3-dom", "ctrl-c-3", "bun run dev"]];
  for (const cycle of cycles) available = await runCycle(fixture, cycle, installed, available);
  const blocked = !available ? "Shell did not recover after foreground stop" : undefined;
  const tail = await page.evaluate(() => globalThis.shellProduct.diagnostics().tailAvailable);
  await stage(fixture, "build-tail", async () => {
    const output = await command("set -o pipefail; bun run build | tail -n 8 && echo BUILD_PIPE_OK", "BUILD_PIPE_OK");
    assert.ok(page);
    for (const path of fixture.buildOutputs) assert.ok(await page.evaluate(path => globalThis.shellProduct.readFile(path), `/home/guest/${fixture.id}/${path}`), `Missing build output ${path}`);
    return output;
  }, !tail ? "Public shell has no standalone tail registration; awaiting Shell track artifact/API" : !installed ? "Guest install failed" : blocked);
  await stage(fixture, "bun-x-grep", () => command(`set -o pipefail; bun x --no-install ${fixture.tool} --version | grep ${fixture.tool === "next" ? "Next" : "vite"}`), !installed ? "Guest install failed" : blocked);
  await stage(fixture, "redirect", async () => {
    const output = await command("bun -e 'console.log(\"REDIRECT_REAL_BUN\")' > output.txt && cat output.txt", "REDIRECT_REAL_BUN");
    assert.ok(page);
    assert.equal(await page.evaluate(path => globalThis.shellProduct.readFile(path), `/home/guest/${fixture.id}/output.txt`), "REDIRECT_REAL_BUN\n");
    return output;
  }, blocked);
  await stage(fixture, "and-or-status", () => command("bun -e 'process.exit(7)' && echo WRONG_SUCCESS; echo EXIT:$?; bun -e 'process.exit(7)' || echo OR_BRANCH; bun -e 'console.log(\"OK_BRANCH\")' && echo AND_BRANCH", "EXIT:7").then(output => {
    const lines = output.split(/\r?\n/);
    assert.ok(lines.includes("OR_BRANCH") && lines.includes("AND_BRANCH") && !lines.includes("WRONG_SUCCESS")); return output;
  }), blocked);
  await stage(fixture, "cwd", () => command(`cd /home/guest && bun -e 'console.log("CWD:"+process.cwd())'; cd /home/guest/${fixture.id}`, "CWD:/home/guest"), blocked);
  const portStarted = await stage(fixture, "port-3001-dom", () => dev(fixture, "PORT=3001 bun run dev", 3001), !installed ? "Guest install failed" : blocked);
  const portPending = await page.evaluate(() => Boolean(globalThis.shellProduct.diagnostics().pending));
  await stage(fixture, "ctrl-c-port", interrupt, !installed || blocked || !portPending ? "No runnable foreground session" : undefined);
  if (!portStarted) await capture();
  await stopAfterFailure().catch(error => console.error(message(error)));
  await page.evaluate(() => globalThis.shellProduct.close());
}
async function preflight() {
  const artifact = process.env.SHELL_PRODUCT_GUEST;
  const accepted = process.env.SHELL_PRODUCT_RECEIPT;
  assert.ok(artifact && accepted && isAbsolute(artifact) && isAbsolute(accepted), "Set absolute SHELL_PRODUCT_GUEST and SHELL_PRODUCT_RECEIPT");
  const bytes = await Bun.file(artifact).bytes();
  const sidecar: unknown = await Bun.file(`${artifact}.build.json`).json();
  verifyGuestBuildReceipt(bytes, sidecar);
  const receipt = await readFile(accepted, "utf8");
  assert.ok(receipt.includes(`guest_sha256=${sidecar.artifactSha256}`), "Guest matches independent accepted receipt");
  const source = /^source_commit=([a-f0-9]{40})$/m.exec(receipt)?.[1];
  assert.ok(source, "Independent receipt has producer source revision");
  return { bytes, source };
}
try {
  scratch = await mkdtemp("/work/tmp/bw-sp-");
  console.log(JSON.stringify({ resources: { scratch, created: ["loopback asset server", "replay registry server", "headless browser", "consumer app sources"], borrowed: ["accepted guest", "explicit package installation", "registry replay", "browser cache"] } }));
  const accepted = await preflight();
  const installation = process.env.SHELL_PRODUCT_INSTALL;
  const corpus = process.env.SHELL_PRODUCT_REGISTRY;
  assert.ok(installation && isAbsolute(installation), "SHELL_PRODUCT_INSTALL must name a prepared public package installation");
  assert.ok(corpus && isAbsolute(corpus), "SHELL_PRODUCT_REGISTRY must name the existing read-only replay corpus");
  // Cleanup owns this exact app path even if bundling fails partway through.
  app = join(scratch, "app");
  assert.ok(!existsSync(app), "Task app directory must not already exist");
  const output = join(scratch, "dist");
  const inputs = await bundleProduct(root, installation, output);
  await Bun.write(join(reports, "inputs.json"), JSON.stringify({ ...inputs, guestSource: accepted.source }, null, 2));
  mirror = await registry({ directory: corpus, record: false });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/bun-guest.wasm") return new Response(accepted.bytes, { headers: { ...headers, "Content-Type": "application/wasm" } });
    const path = resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(output + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  const playwright = await import(process.env.PLAYWRIGHT ?? pathToFileURL(join(installation, "node_modules/playwright/index.mjs")).href);
  launching = playwright.chromium.launch({ headless: true, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } }); browser = await launching;
  assert.ok(browser);
  const context = await browser.newContext();
  const registryBase = mirror.base;
  await context.route("**/*", route => browserRegistryRoute(route, registryBase, external));
  page = await context.newPage();
  page.on("console", msg => console.log(`browser ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", error => console.error(`browser error: ${error.stack}`));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForFunction(() => Boolean(globalThis.shellProduct));
  await page.evaluate(() => globalThis.shellProduct.setup());
  await record({ app: "all", stage: "setup", status: "pass", detail: "Real public packages, shared peer, accepted guest, terminal and preview service worker ready" });
  for (const fixture of fixtures) await runFixture(fixture);
  const released = await page.evaluate(() => globalThis.shellProduct.cleanup());
  assert.deepEqual(released, { workers: 0, listeners: 0 });
  await record({ app: "all", stage: "cleanup", status: "pass", detail: JSON.stringify(released) });
  const networkErrors = external.concat(mirror.misses, mirror.errors);
  await record({ app: "all", stage: "network", status: networkErrors.length ? "fail" : "pass", detail: networkErrors.length ? JSON.stringify(networkErrors) : "No external requests or missing/error replay objects" });
  await Bun.write(join(reports, "registry.json"), JSON.stringify(mirror.snapshot(), null, 2));
} catch (error) {
  await record({ app: "all", stage: "setup", status: "fail", detail: message(error) });
} finally {
  for (const fixture of fixtures) await missingStages(fixture);
  clearTimeout(deadline);
  const assetPort = server?.port;
  const registryPort = mirror ? Number(new URL(mirror.base).port) : undefined;
  await cleanup();
  if (assetPort) assert.equal(await portOpen(assetPort), false, "Owned asset listener released");
  if (registryPort) assert.equal(await portOpen(registryPort), false, "Owned registry listener released");
  assert.ok(!browser?.isConnected(), "Owned browser disconnected");
  assert.ok(!scratch || !existsSync(scratch), "Owned scratch removed");
  assert.ok(!app || !existsSync(app), "Owned consumer app removed");
  console.log("Cleanup checked: browser closed, servers stopped, task app and scratch removed; borrowed inputs preserved");
}
process.exitCode = rows.some(row => row.status !== "pass") ? 1 : 0;
