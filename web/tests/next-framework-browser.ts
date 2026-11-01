import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Page } from "playwright";
import type { Runtime } from "waffle";
import { playwright, ready, run, session, terminalText, writeFile } from "./playground.mjs";
import { stopForeground } from "./foreground";
import { nextRegistry } from "./next-framework-registry";
import { nextPageContract } from "./next-framework-contract";
import { observePreviewSockets, previewSocketEvents } from "./next-framework-sockets";

type PlaygroundGlobal = typeof globalThis & {
  playground: {
    shell: { submit(command: string): Promise<void>; lastExit: number; running: boolean; input(text: string): void };
    previews: { serves(port: number): boolean; url(port: number): string };
    fs: Pick<Runtime["filesystem"], "readFile" | "createIdentity" | "revoke" | "reap">;
  };
  nextFinished: boolean;
};
const reports = resolve(process.env.NEXT_REPORTS ?? "/work/tmp/bun-wasm-next-browser");
const fixture = resolve(import.meta.dir, "../../examples/frameworks");
const assets = process.env.NEXT_WEB_ROOT;
const supplemental = process.env.NEXT_REGISTRY_EXTRA;
if (!assets || !supplemental) throw new Error("Set NEXT_WEB_ROOT to a browser playground build and NEXT_REGISTRY_EXTRA to staged locked tarballs");
mkdirSync(reports, { recursive: true });
const receipt = JSON.parse(readFileSync(join(assets, "engine-builds.json"), "utf8"));
assert.equal(receipt["bun-browser.wasm"], "5e37d2afc8d73da8544ba4c1ac32d6c899b85ce1b2325892dd8aa9dcbc4a53bb", "Expected baseline guest");
const rawGuest = process.env.NEXT_GUEST_WASM;
if (!rawGuest) throw new Error("Set NEXT_GUEST_WASM for independent digest verification");
assert.equal(createHash("sha256").update(readFileSync(rawGuest)).digest("hex"), receipt["bun-browser.wasm"]);
assert.equal(createHash("sha256").update(gunzipSync(readFileSync(join(assets, "bun-browser.wasm.gz")))).digest("hex"), receipt["bun-browser.wasm"], "Distributed guest bytes match the verified raw guest");
const task = session("next-browser-");
let registry: ReturnType<typeof nextRegistry> | undefined;
const stages: Record<string, unknown> = { dev: { status: "not-run" }, build: { status: "not-run" }, start: { status: "blocked", reason: "requires a guest build" } };
const external: string[] = [];
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(1)); }, 900000);

async function guestCommand(page: Page, stage: string, command: string, timeout = 120000) {
  process.stdout.write(`START ${stage}: ${command}\n`);
  const result = await run(page, command, timeout);
  process.stdout.write(`END ${stage}: exit=${result.code} ms=${result.ms}\n`);
  stages[stage] = { status: result.code === 0 ? "pass" : "fail", command, ...result };
  writeFileSync(join(reports, `browser-${stage}.log`), result.output);
  assert.equal(result.code, 0, `${stage} failed: ${result.output}`);
  return result;
}

function sourceFiles(directory: string, prefix = ""): string[] {
  let files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (["node_modules", ".next", "next-env.d.ts"].includes(name) || name.endsWith("tsbuildinfo")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { files = files.concat(sourceFiles(path, `${prefix}${name}/`)); continue; }
    if (/\.(?:tsx?|json|lock|txt)$/.test(name)) files.push(prefix + name);
  }
  return files;
}

async function serverStage(page: Page, stage: "dev" | "start", command: string) {
  await page.evaluate(command => {
    const state = globalThis as PlaygroundGlobal;
    state.nextFinished = false;
    void state.playground.shell.submit(command).finally(() => { state.nextFinished = true; });
  }, command);
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    const state = await page.evaluate(() => ({ done: (globalThis as PlaygroundGlobal).nextFinished, listening: (globalThis as PlaygroundGlobal).playground.previews.serves(43100) }));
    if (state.done) throw new Error(`Guest server exited before Next listener: ${await terminalText(page)}`);
    if (state.listening) break;
    await page.waitForTimeout(100);
  }
  const url = await page.evaluate(() => (globalThis as PlaygroundGlobal).playground.previews.url(43100));
  const preview = await page.context().newPage();
  try {
    const requests = await nextPageContract(preview, url, true);
    if (stage === "dev") await browserHotUpdate(preview, page, url);
    stages[stage] = { status: "pass", url };
    writeFileSync(join(reports, `browser-${stage}-requests.json`), JSON.stringify(requests, null, 2));
    await preview.screenshot({ path: join(reports, `browser-${stage}.png`) });
  } finally { await preview.close(); }
}

async function storageCounters(page: Page) {
  return page.evaluate(() => {
    const fs = (globalThis as PlaygroundGlobal).playground.fs;
    const identity = fs.createIdentity();
    try {
      // Read-only f6017d12 shared allocator layout; the guest digest is checked above.
      const cells = new Int32Array(identity.shared);
      const pageBytes = 65536;
      const totalPages = identity.maxBytes / pageBytes;
      const slots = new Int32Array(identity.shared, (16 + totalPages) * 4, 4096 * 12);
      const files = Array.from({ length: 4095 }, (_value, slot) => Atomics.load(slots, (slot + 1) * 12)).filter(value => value !== 0).length;
      return { usedBytes: Atomics.load(cells, 2) * pageBytes, maxBytes: identity.maxBytes, files };
    } finally { fs.revoke(identity); fs.reap(identity); }
  });
}

async function stopGuest(page: Page) {
  await page.evaluate(() => {
    const shell = (globalThis as PlaygroundGlobal).playground.shell;
    if (shell.running) shell.input("\x03");
  });
  try {
    await page.waitForFunction(() => !(globalThis as PlaygroundGlobal).playground.shell.running, undefined, { timeout: 5000 });
  } catch { await stopForeground(page, 5000); }
}

async function browserHotUpdate(preview: Page, page: Page, base: string) {
  const source = readFileSync(join(fixture, "app/page.tsx"), "utf8");
  await observePreviewSockets(preview);
  try {
    await preview.goto(base);
    await preview.getByRole("heading", { name: "Five frameworks, one Next app", exact: true }).waitFor();
    const beforeUpdate = (await previewSocketEvents(preview)).length;
    await writeFile(page, "/home/user/app/page.tsx", source.replace("Five frameworks, one Next app", "Guest hot update"));
    await preview.getByRole("heading", { name: "Guest hot update", exact: true }).waitFor({ timeout: 30000 });
    const events = await previewSocketEvents(preview);
    const sockets = events.filter(event => event.url.includes("/_next/webpack-hmr"));
    const updates = events.slice(beforeUpdate).filter(event => event.url.includes("/_next/webpack-hmr"));
    assert.ok(sockets.some(event => event.type === "open"), "preview HMR socket opened");
    assert.ok(updates.some(event => event.type === "message"), "preview HMR socket received an update after the source edit");
    writeFileSync(join(reports, "browser-hmr.json"), JSON.stringify({ status: "pass", sockets }));
  } finally { await writeFile(page, "/home/user/app/page.tsx", source); }
}

async function runServer(page: Page, stage: "dev" | "start", mode: "dev" | "prod") {
  try { await serverStage(page, stage, `bun run server.ts ${mode}`); }
  catch (error) { stages[stage] = { status: "fail", error: String(error) }; }
  finally {
    await stopGuest(page);
    writeFileSync(join(reports, `browser-${stage}.log`), await terminalText(page));
  }
}

try {
  registry = nextRegistry(supplemental, Number(process.env.NEXT_REGISTRY_PORT ?? "43221"));
  const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: assets, PORT: process.env.NEXT_WEB_PORT ?? "43220" });
  const browser = await task.launch(playwright.chromium);
  const context = await browser.newContext({ serviceWorkers: "allow" });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${match[1]}?engine=browser&prompt=off`);
  assert.match(await ready(page), /ready · Browser/);
  for (const path of sourceFiles(fixture)) await writeFile(page, `/home/user/${path}`, readFileSync(join(fixture, path), "utf8"));
  await writeFile(page, "/home/user/bunfig.toml", `[install]\nregistry = ${JSON.stringify(registry.base)}\n`);
  let installed = false;
  try {
    await guestCommand(page, "install", "bun install --frozen-lockfile", 600000);
    installed = true;
  } catch (error) { stages.installFailure = String(error); }
  stages.filesystemAfterInstall = await storageCounters(page);
  try { await guestCommand(page, "compiler", "bun run compiler-probe.ts"); }
  catch (error) {
    stages.compiler = { status: "fail", error: String(error) };
    stages.dev = { status: "blocked", reason: "compiler load failed" };
    stages.build = { status: "blocked", reason: "compiler load failed" };
    throw error;
  }
  if (!installed) {
    stages.dev = { status: "blocked", reason: "frozen install incomplete" };
    stages.build = { status: "blocked", reason: "frozen install incomplete" };
    throw new Error("Frozen install incomplete; compiler measured but Next server gates remain blocked");
  }
  await runServer(page, "dev", "dev");
  let built = false;
  try {
    await guestCommand(page, "build", "bun run node_modules/next/dist/bin/next build", 180000);
    built = true;
  }
  catch (error) { stages.build = { status: "fail", error: String(error) }; }
  const buildID = await page.evaluate(async () => {
    const bytes = await (globalThis as PlaygroundGlobal).playground.fs.readFile("/home/user/.next/BUILD_ID");
    return bytes ? new TextDecoder().decode(bytes) : null;
  });
  if (built && buildID) await runServer(page, "start", "prod");
  if (built && !buildID) stages.build = { status: "fail", error: "Build exited zero without a guest BUILD_ID" };
  stages.buildID = buildID;
  assert.deepEqual(external, []);
  assert.deepEqual(registry.misses, []);
} catch (error) {
  stages.failure = String(error);
} finally {
  clearTimeout(timer);
  const mirror = registry ? { requests: registry.requests, misses: registry.misses } : null;
  try { await registry?.close(); } finally { await task.cleanup(); }
  writeFileSync(join(reports, "browser-results.json"), JSON.stringify({ guest: receipt, stages, mirror, external, cleanup: true }, null, 2));
}
process.stdout.write(JSON.stringify(stages, null, 2) + "\n");
if (Object.values(stages).some(value => value && typeof value === "object" && "status" in value && value.status !== "pass") || stages.failure) process.exitCode = 1;
