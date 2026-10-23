import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Browser, BrowserType } from "playwright";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt";
import { bundleConsumer, installConsumer } from "./shell-consumer-install";

const browsers = process.argv.slice(2);
assert.ok(browsers.length && browsers.every(value => ["chromium", "firefox", "webkit"].includes(value)), "name explicit browsers: chromium firefox webkit");
const artifactPath = process.env.SHELL_CONSUMER_GUEST;
const inputsPath = process.env.SHELL_CONSUMER_EXPECTED_INPUTS;
assert.ok(artifactPath && isAbsolute(artifactPath), "SHELL_CONSUMER_GUEST must be an absolute selected guest path");
assert.ok(inputsPath && isAbsolute(inputsPath), "SHELL_CONSUMER_EXPECTED_INPUTS must be an absolute independently accepted inputs JSON path");
const artifact = await realpath(artifactPath);
const bytes = await Bun.file(artifact).bytes();
const receipt: unknown = await Bun.file(`${artifact}.build.json`).json();
verifyGuestBuildReceipt(bytes, receipt);
const accepted: unknown = await Bun.file(inputsPath).json();
assert.ok(accepted && typeof accepted === "object", "accepted guest inputs must be an object");
for (const field of ["bunHead", "bunTree", "sysrootReceiptSha256"] as const) assert.equal(receipt[field], Reflect.get(accepted, field), `accepted guest ${field}`);
console.log(JSON.stringify({ preflight: { artifact, receipt, inputsPath } }));
if (process.env.SHELL_CONSUMER_PREFLIGHT_ONLY === "1") process.exit(0);
const port = Number(process.env.SHELL_CONSUMER_PORT);
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, "SHELL_CONSUMER_PORT must be an explicit free port");
const root = resolve(import.meta.dir, "../..");
const ownedCommands = new Set<ChildProcess>();
let scratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launching: Promise<Browser> | undefined;
let cleanupPromise: Promise<void> | undefined;
function kill(command: ChildProcess) {
  if (!command.pid) return;
  try { process.kill(-command.pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
}
function execute(command: string[], cwd: string, env = process.env): Promise<void> {
  const [program, ...args] = command;
  assert.ok(program, "nonempty build command");
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env, stdio: "inherit", detached: true }); ownedCommands.add(child);
    child.once("error", reject);
    child.once("close", code => { kill(child); ownedCommands.delete(child); if (code === 0) resolve(); else reject(new Error(`${command.join(" ")} exited ${code}`)); });
  });
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    await Promise.all(Array.from(ownedCommands, child => new Promise<void>(resolve => { child.once("close", () => resolve()); kill(child); })));
    try { await (browser ?? await launching?.catch(() => undefined))?.close(); }
    finally { server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void cleanup().finally(() => process.exit(1)));
const deadline = setTimeout(() => { console.error("shell consumer deadline"); void cleanup().finally(() => process.exit(1)); }, 900000);
function caseResults(value: unknown) {
  assert.ok(value && typeof value === "object" && "results" in value && Array.isArray(value.results), "consumer results");
  return value.results.map((item: unknown) => {
    assert.ok(item && typeof item === "object" && "name" in item && typeof item.name === "string" && "ok" in item && typeof item.ok === "boolean", "case result");
    return { name: item.name, ok: item.ok };
  });
}
async function exercise(browserName: string, type: BrowserType, installation: string) {
  assert.ok(existsSync(type.executablePath()), `cached ${browserName} executable required`);
  launching = type.launch({ headless: true }); browser = await launching;
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let failed = false;
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => Reflect.has(globalThis, "shellConsumer"));
    const result: unknown = await page.evaluate(() => Reflect.get(globalThis, "shellConsumer").exercise());
    console.log(JSON.stringify({ browser: browserName, installation, result, errors }));
    const cases = caseResults(result);
    assert.deepEqual(cases.map(item => item.name), ["lookup", "files-cwd-env-exit9", "epipe", "nested-stdin", "live-ticker", "binary", "interrupt", "preview"]);
    failed = cases.some(item => !item.ok);
    const previewCase = cases.find(item => item.name === "preview");
    if (previewCase?.ok) {
      const preview = await context.newPage();
      const response = await preview.goto(`http://127.0.0.1:${port}/__preview/31976/`);
      assert.ok(response, "preview response");
      assert.ok(response.fromServiceWorker(), "preview delivered by actual shared network service worker");
      assert.equal(response.status(), 200);
      assert.equal(await preview.locator("body").innerText(), "REAL_SHELL_PREVIEW");
      console.log(JSON.stringify({ browser: browserName, preview: { serviceWorker: true, status: response.status(), body: "REAL_SHELL_PREVIEW" } }));
      await preview.close();
    }
  } catch (error) {
    failed = true;
    console.error(JSON.stringify({ browser: browserName, error: String(error), diagnostics: await page.evaluate(() => Reflect.get(globalThis, "shellConsumer")?.diagnostics()).catch(String), errors }));
  } finally {
    try {
      const released = await page.evaluate(() => Reflect.get(globalThis, "shellConsumer")?.cleanup());
      console.log(JSON.stringify({ browser: browserName, cleanup: released }));
      assert.deepEqual(released, { workers: 0, listeners: 0, pageListeners: 0, sessions: 0, borrowerPreservedUntilOwnerDisposal: true });
      assert.deepEqual(errors, [], "no page errors");
    } catch (error) { failed = true; console.error(JSON.stringify({ browser: browserName, cleanupError: String(error) })); }
    await context.close(); await browser.close(); browser = undefined; launching = undefined;
  }
  return !failed;
}
try {
  scratch = await mkdtemp(join(process.env.SHELL_CONSUMER_SCRATCH ?? tmpdir(), "bw-shell-"));
  // A prepared installation is an explicit borrowed input for development reruns.
  // Default runs install both public packages and compile the shell in owned scratch.
  const installation = process.env.SHELL_CONSUMER_INSTALL ?? join(scratch, "consumer");
  assert.ok(isAbsolute(installation), "prepared installation must be absolute");
  console.log(JSON.stringify({ resources: { borrowed: { artifact, installation: process.env.SHELL_CONSUMER_INSTALL ?? null, browsers: process.env.PLAYWRIGHT_BROWSERS_PATH ?? "host cache" }, created: { scratch, port, commands: "installation and shell compiler process groups", browserContexts: browsers } } }));
  if (!process.env.SHELL_CONSUMER_INSTALL) await installConsumer(root, installation, execute);
  const output = join(scratch, "dist");
  const packages = await bundleConsumer(root, installation, output, execute);
  console.log(JSON.stringify({ packages }));
  server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    if (pathname === "/bun-guest.wasm") return new Response(bytes, { headers: { ...headers, "Content-Type": "application/wasm" } });
    const path = resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(output + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  const types: typeof import("playwright") = await import(pathToFileURL(join(installation, "node_modules/playwright/index.mjs")).href);
  const passed: boolean[] = [];
  for (const selected of browsers) {
    assert.ok(selected === "chromium" || selected === "firefox" || selected === "webkit");
    passed.push(await exercise(selected, types[selected], installation));
  }
  assert.ok(passed.every(Boolean), "every requested browser and case must pass; failures above remain blocking");
} finally {
  clearTimeout(deadline); await cleanup();
  assert.equal(scratch ? existsSync(scratch) : false, false, "owned scratch removed");
  const listening = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false);
  assert.equal(listening, false, "owned HTTP port released");
  console.log(JSON.stringify({ hostCleanup: { scratchRemoved: true, browserClosed: true, listenerStopped: true, commands: ownedCommands.size, borrowedGuestPreserved: await Bun.file(artifact).exists() } }));
}
