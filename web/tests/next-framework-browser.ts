import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Page } from "playwright";
import type { Runtime } from "waffle";
import type { ShellHost } from "../src/shell";
import { playwright, ready, run, session, terminalText, writeFile } from "./playground.mjs";
import { stopForeground } from "./foreground";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt";
import { nextRegistry } from "./next-framework-registry";
import { isNextDistTagsRequest, nextDistTags, nextDistTagsResponse } from "./next-framework-offline";
import { nextPageContract } from "./next-framework-contract";
import { observePreviewSockets, previewSocketEvents } from "./next-framework-sockets";

type PlaygroundGlobal = typeof globalThis & {
  playground: {
    shell: { submit(command: string): Promise<void>; lastExit: number; running: boolean; input(text: string): void; host: Pick<ShellHost, "runBun" | "kill"> };
    previews: { serves(port: number): boolean; url(port: number): string };
    fs: Pick<Runtime["filesystem"], "readFile" | "listFiles" | "createIdentity" | "revoke" | "reap">;
  };
  nextFinished: boolean;
  nextOutput: { stdout: string; stderr: string };
};
const reports = resolve(process.env.NEXT_REPORTS ?? "/work/tmp/bun-wasm-next-browser");
const fixture = resolve(import.meta.dir, "../../examples/frameworks");
const filesystemFixture = resolve(import.meta.dir, "../../tests/fixtures/fs-stream-constructors");
const moduleFixture = resolve(import.meta.dir, "../../tests/fixtures/module-compile");
const cursorFixture = resolve(import.meta.dir, "../../tests/fixtures/stdio-cursor");
const vmFixture = resolve(import.meta.dir, "../../tests/fixtures/vm-context");
const httpFixture = resolve(import.meta.dir, "../../tests/fixtures/net-http-implicit-headers");
const stackFixture = resolve(import.meta.dir, "../../tests/fixtures/stack-source-position");
const bodyFixture = resolve(import.meta.dir, "../../tests/fixtures/request-body-streams");
const assets = process.env.NEXT_WEB_ROOT;
const supplemental = process.env.NEXT_REGISTRY_EXTRA;
if (!assets || !supplemental) throw new Error("Set NEXT_WEB_ROOT to a browser playground build and NEXT_REGISTRY_EXTRA to staged locked tarballs");
mkdirSync(reports, { recursive: true });
const receipt: unknown = JSON.parse(readFileSync(join(assets, "engine-builds.json"), "utf8"));
assert.ok(receipt && typeof receipt === "object" && "bun-browser.wasm" in receipt);
const rawGuest = process.env.NEXT_GUEST_WASM;
const expectedGuest = process.env.NEXT_GUEST_SHA256;
if (!rawGuest || !expectedGuest) throw new Error("Set NEXT_GUEST_WASM and NEXT_GUEST_SHA256 for independent guest verification");
const raw = readFileSync(rawGuest);
const guestReceipt: unknown = JSON.parse(readFileSync(`${rawGuest}.build.json`, "utf8"));
verifyGuestBuildReceipt(raw, guestReceipt);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
assert.equal(digest(raw), expectedGuest, "Selected raw guest matches the declared input");
assert.equal(receipt["bun-browser.wasm"], expectedGuest, "Host build used the selected guest");
assert.equal(digest(gunzipSync(readFileSync(join(assets, "bun-browser.wasm.gz")))), expectedGuest, "Distributed guest bytes match the verified raw guest");
const appRoot = "/home/user/next-framework";
const compilerDirectory = "./node_modules/@next/swc-wasm-nodejs";
const task = session("next-browser-");
let registry: ReturnType<typeof nextRegistry> | undefined;
const stages: Record<string, unknown> = { dev: { status: "not-run" }, build: { status: "not-run" }, start: { status: "blocked", reason: "requires a guest build" } };
const external: string[] = [];
const offlineMetadata: { requestedURL: string; servedURL: string; provenance: string; responseSHA256: string }[] = [];
const timer = setTimeout(() => { void task.cleanup().finally(() => process.exit(1)); }, 900000);

function captureGuestOutput() {
  const state = globalThis as PlaygroundGlobal;
  const host = state.playground.shell.host;
  const original = host.runBun.bind(host);
  const decoder = new TextDecoder();
  const text = (data: string | Uint8Array) => typeof data === "string" ? data : decoder.decode(data);
  state.nextOutput = { stdout: "", stderr: "" };
  host.runBun = (args, cwd, io) => original(args, cwd, {
    out(data) { state.nextOutput.stdout += text(data); io.out(data); },
    err(data) { state.nextOutput.stderr += text(data); io.err(data); },
  });
}

async function resetGuestOutput(page: Page) {
  await page.evaluate(() => { (globalThis as PlaygroundGlobal).nextOutput = { stdout: "", stderr: "" }; });
}

async function saveGuestOutput(page: Page, stage: string) {
  const output = await page.evaluate(() => (globalThis as PlaygroundGlobal).nextOutput);
  writeFileSync(join(reports, `browser-${stage}.stdout.log`), output.stdout);
  writeFileSync(join(reports, `browser-${stage}.stderr.log`), output.stderr);
  return output;
}

async function guestCommand(page: Page, stage: string, command: string, timeout = 120000) {
  process.stdout.write(`START ${stage}: ${command}\n`);
  await resetGuestOutput(page);
  const result = await run(page, command, timeout);
  const raw = await saveGuestOutput(page, stage);
  process.stdout.write(`END ${stage}: exit=${result.code} ms=${result.ms}\n`);
  stages[stage] = { status: result.code === 0 ? "pass" : "fail", command, ...result, raw };
  writeFileSync(join(reports, `browser-${stage}.log`), result.output);
  assert.equal(result.code, 0, `${stage} failed: ${raw.stdout}${raw.stderr}`);
  return result;
}

async function cursorOutputFixture(page: Page) {
  const result = await page.evaluate(async () => {
    const { host } = (globalThis as PlaygroundGlobal).playground.shell;
    const encoder = new TextEncoder();
    let stdout: number[] = [];
    let stderr: number[] = [];
    const bytes = (data: string | Uint8Array) => Array.from(typeof data === "string" ? encoder.encode(data) : data);
    const io = {
      out(data: string | Uint8Array) { stdout = stdout.concat(bytes(data)); },
      err(data: string | Uint8Array) { stderr = stderr.concat(bytes(data)); },
    };
    const started = performance.now();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; host.kill(); }, 60000);
    try {
      const code = await host.runBun(["run", "stdio-cursor/index.ts"], "/home/user", io);
      return { code, ms: performance.now() - started, timedOut, stdout, stderr };
    } finally { clearTimeout(timer); }
  });
  const stdout = Buffer.from(result.stdout);
  const stderr = Buffer.from(result.stderr);
  const expectedOut = readFileSync(join(cursorFixture, "expected.txt"));
  const expectedErr = readFileSync(join(cursorFixture, "expected_stderr.txt"));
  const passed = !result.timedOut && result.code === 0 && stdout.equals(expectedOut) && stderr.equals(expectedErr);
  stages["stdio-cursor"] = { status: passed ? "pass" : "fail", ...result };
  writeFileSync(join(reports, "browser-stdio-cursor.stdout.log"), stdout);
  writeFileSync(join(reports, "browser-stdio-cursor.stderr.log"), stderr);
  assert.equal(result.timedOut, false, "stdio-cursor finished within its 60-second fixture budget");
  assert.equal(result.code, 0, `stdio-cursor failed: ${stderr.toString()}`);
  assert.deepEqual(stdout, expectedOut, "stdio-cursor raw stdout ANSI bytes and callback assertions");
  assert.deepEqual(stderr, expectedErr, "stdio-cursor raw stderr ANSI bytes");
}

function sourceFiles(directory: string, prefix = "", excluded: readonly string[] = ["node_modules", ".next", "next-env.d.ts"]): string[] {
  let files: string[] = [];
  for (const name of readdirSync(directory)) {
    if (excluded.includes(name) || name.endsWith("tsbuildinfo")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) { files = files.concat(sourceFiles(path, `${prefix}${name}/`, excluded)); continue; }
    if (name === ".env" || /\.(?:tsx?|json|lock|txt)$/.test(name)) files.push(prefix + name);
  }
  return files;
}

async function serverStage(page: Page, stage: "dev" | "start", command: string) {
  process.stdout.write(`START ${stage}: ${command}\n`);
  await page.evaluate(command => {
    const state = globalThis as PlaygroundGlobal;
    state.nextFinished = false;
    void state.playground.shell.submit(command).finally(() => { state.nextFinished = true; });
  }, command);
  const until = Date.now() + 120000;
  let listening = false;
  while (Date.now() < until) {
    const state = await page.evaluate(() => ({ done: (globalThis as PlaygroundGlobal).nextFinished, listening: (globalThis as PlaygroundGlobal).playground.previews.serves(43100) }));
    if (state.done) throw new Error(`Guest server exited before Next listener: ${await terminalText(page)}`);
    if (state.listening) { listening = true; break; }
    await page.waitForTimeout(100);
  }
  assert.ok(listening, `Guest ${stage} listener timed out: ${await terminalText(page)}`);
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
  const maxBytes = await page.evaluate(() => {
    const fs = (globalThis as PlaygroundGlobal).playground.fs;
    const identity = fs.createIdentity();
    try { return identity.maxBytes; }
    finally { fs.revoke(identity); fs.reap(identity); }
  });
  assert.equal(maxBytes, 1024 * 1024 * 1024, "Unchanged 1 GiB guest filesystem budget");
  const files = await page.evaluate(async () => (await (globalThis as PlaygroundGlobal).playground.fs.listFiles("/home/user")).length);
  return { maxBytes, files };
}

async function fixtureSnapshot(page: Page, stage: string) {
  const observed = await page.evaluate(async root => {
    const fs = (globalThis as PlaygroundGlobal).playground.fs;
    const lock = await fs.readFile(`${root}/bun.lock`);
    const manifest = await fs.readFile(`${root}/package.json`);
    return { lock: lock ? Array.from(lock) : null, manifest: manifest ? Array.from(manifest) : null };
  }, appRoot);
  assert.ok(observed.lock && observed.manifest, "Guest lock and manifest exist");
  const lock = Buffer.from(observed.lock);
  const manifest = Buffer.from(observed.manifest);
  writeFileSync(join(reports, `${stage}-bun.lock`), lock);
  assert.deepEqual(lock, readFileSync(join(fixture, "bun.lock")), "Unchanged fixture lock bytes");
  assert.deepEqual(manifest, readFileSync(join(fixture, "package.json")), "Unchanged fixture manifest bytes");
  return { lock: { bytes: lock.length, sha256: digest(lock) }, manifest: { bytes: manifest.length, sha256: digest(manifest) } };
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
    await writeFile(page, `${appRoot}/app/page.tsx`, source.replace("Five frameworks, one Next app", "Guest hot update"));
    await preview.getByRole("heading", { name: "Guest hot update", exact: true }).waitFor({ timeout: 30000 });
    const events = await previewSocketEvents(preview);
    const sockets = events.filter(event => event.url.includes("/_next/webpack-hmr"));
    const updates = events.slice(beforeUpdate).filter(event => event.url.includes("/_next/webpack-hmr"));
    assert.ok(sockets.some(event => event.type === "open"), "preview HMR socket opened");
    assert.ok(updates.some(event => event.type === "message"), "preview HMR socket received an update after the source edit");
    writeFileSync(join(reports, "browser-hmr.json"), JSON.stringify({ status: "pass", sockets }));
  } finally { await writeFile(page, `${appRoot}/app/page.tsx`, source); }
}

async function runServer(page: Page, stage: "dev" | "start", mode: "dev" | "prod") {
  await resetGuestOutput(page);
  try { await serverStage(page, stage, `bun run server.ts ${mode}`); }
  catch (error) {
    stages[stage] = { status: "fail", error: String(error) };
    process.stdout.write(`FAIL ${stage}: ${String(error)}\n${await terminalText(page)}\n`);
  }
  finally {
    await stopGuest(page);
    await saveGuestOutput(page, stage);
    writeFileSync(join(reports, `browser-${stage}.log`), await terminalText(page));
  }
}

try {
  registry = nextRegistry(supplemental, Number(process.env.NEXT_REGISTRY_PORT ?? "43221"), nextDistTagsResponse);
  const match = await task.start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { ROOT: assets, PORT: process.env.NEXT_WEB_PORT ?? "43220" });
  const browser = await task.launch(playwright.chromium);
  const context = await browser.newContext({ serviceWorkers: "allow" });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (isNextDistTagsRequest(request.url(), request.method())) {
      assert.ok(registry);
      const servedURL = registry.base + nextDistTags.registryPath;
      offlineMetadata.push({ requestedURL: request.url(), servedURL, provenance: nextDistTags.provenance, responseSHA256: digest(Buffer.from(nextDistTags.body)) });
      const response = await route.fetch({ url: servedURL });
      assert.equal(await response.text(), nextDistTags.body);
      return route.fulfill({ response });
    }
    if (["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${match[1]}?engine=browser`);
  assert.match(await ready(page), /ready · Browser/);
  await page.evaluate(captureGuestOutput);
  for (const path of sourceFiles(vmFixture, "", [])) await writeFile(page, `/home/user/vm-context/${path}`, readFileSync(join(vmFixture, path), "utf8"));
  await guestCommand(page, "vm-context", "bun run vm-context/index.ts");
  for (const path of sourceFiles(moduleFixture, "", [])) await writeFile(page, `/home/user/module-compile/${path}`, readFileSync(join(moduleFixture, path), "utf8"));
  await guestCommand(page, "module-compile", "bun run module-compile/index.ts");
  for (const path of sourceFiles(filesystemFixture, "", [])) await writeFile(page, `/home/user/fs-stream-constructors/${path}`, readFileSync(join(filesystemFixture, path), "utf8"));
  await guestCommand(page, "fs-stream-constructors", "bun run fs-stream-constructors/index.ts");
  for (const path of sourceFiles(cursorFixture, "", [])) await writeFile(page, `/home/user/stdio-cursor/${path}`, readFileSync(join(cursorFixture, path), "utf8"));
  await cursorOutputFixture(page);
  for (const path of sourceFiles(httpFixture, "", [])) await writeFile(page, `/home/user/net-http-implicit-headers/${path}`, readFileSync(join(httpFixture, path), "utf8"));
  await guestCommand(page, "net-http-implicit-headers", "bun run net-http-implicit-headers/index.ts");
  for (const path of sourceFiles(bodyFixture, "", [])) await writeFile(page, `/home/user/request-body-streams/${path}`, readFileSync(join(bodyFixture, path), "utf8"));
  await guestCommand(page, "request-body-streams", "bun run request-body-streams/index.ts");
  for (const path of sourceFiles(stackFixture, "", [])) await writeFile(page, `/home/user/stack-source-position/${path}`, readFileSync(join(stackFixture, path), "utf8"));
  await guestCommand(page, "stack-source-position", "bun run stack-source-position/index.ts");
  const beforeApp = await page.evaluate(async root => ({
    files: await (globalThis as PlaygroundGlobal).playground.fs.listFiles(root),
    seed: await (globalThis as PlaygroundGlobal).playground.fs.readFile("/home/user/files.ts"),
  }), appRoot);
  assert.deepEqual(beforeApp.files, [], "Application workspace starts empty and separate from playground examples and probes");
  assert.ok(beforeApp.seed, "Playground examples remain outside the application workspace");
  stages.workspaceIsolation = { root: appRoot, seedSHA256: digest(beforeApp.seed) };
  const fixtureFiles = sourceFiles(fixture);
  for (const path of fixtureFiles) await writeFile(page, `${appRoot}/${path}`, readFileSync(join(fixture, path), "utf8"));
  const stagedFiles = await page.evaluate(root => (globalThis as PlaygroundGlobal).playground.fs.listFiles(root), appRoot);
  assert.deepEqual(stagedFiles.toSorted(), fixtureFiles.map(path => `${appRoot}/${path}`).sort(), "Only the complete expected fixture source is under the application root");
  await guestCommand(page, "workspace", `cd ${appRoot}`);
  await writeFile(page, `${appRoot}/bunfig.toml`, `[install]\nregistry = ${JSON.stringify(registry.base)}\n`);
  stages.fixtureBefore = await fixtureSnapshot(page, "before");
  stages.filesystemBefore = await storageCounters(page);
  let installed = false;
  try {
    await guestCommand(page, "install", "bun install --frozen-lockfile", 600000);
    installed = true;
  } catch (error) { stages.installFailure = String(error); }
  stages.filesystemAfterInstall = await storageCounters(page);
  stages.fixtureAfterInstall = await fixtureSnapshot(page, "after-install");
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
  stages.fixtureAfterCompiler = await fixtureSnapshot(page, "after-compiler");
  await writeFile(page, "/tmp/next-probes/compiler-discovery.ts", readFileSync(join(import.meta.dir, "next-framework-compiler-discovery.ts"), "utf8"));
  await guestCommand(page, "compiler-discovery", "bun run /tmp/next-probes/compiler-discovery.ts");
  await writeFile(page, "/tmp/next-probes/cache-stream-probe.ts", readFileSync(join(import.meta.dir, "next-framework-cache-probe.ts"), "utf8"));
  try { await guestCommand(page, "cache-stream-probe", "bun run /tmp/next-probes/cache-stream-probe.ts"); }
  catch (error) { process.stdout.write(`FAIL cache-stream-probe, continuing independent application gates: ${String(error)}\n`); }
  await guestCommand(page, "compiler-bare-import", "bun -e 'const compiler = await import(\"@next/swc-wasm-nodejs\"); const result = compiler.transformSync(\"const value: number = 42;\", { filename: \"probe.ts\", jsc: { parser: { syntax: \"typescript\" } } }); if (!result.code.includes(\"42\") || result.code.includes(\": number\")) throw new Error(\"Bare dynamic import compiler failed\"); console.log(\"bare dynamic import transformed TypeScript\");'");
  const seeded = await page.evaluate(() => (globalThis as PlaygroundGlobal).playground.fs.readFile("/home/user/files.ts"));
  assert.ok(seeded);
  assert.equal(digest(seeded), digest(beforeApp.seed), "Application staging must not change the sibling playground example");
  stages.compilerSelection = { environment: "NEXT_TEST_WASM_DIR", source: "fixture .env loaded by Next", directory: compilerDirectory, reason: "Explicit published Next WASM compiler path; no package patch" };
  await runServer(page, "dev", "dev");
  let built = false;
  try {
    await guestCommand(page, "build", "bun run node_modules/next/dist/bin/next build", 180000);
    built = true;
  }
  catch (error) { stages.build = { status: "fail", error: String(error) }; }
  const buildID = await page.evaluate(async root => {
    const bytes = await (globalThis as PlaygroundGlobal).playground.fs.readFile(`${root}/.next/BUILD_ID`);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }, appRoot);
  if (built && buildID) await runServer(page, "start", "prod");
  if (built && !buildID) stages.build = { status: "fail", error: "Build exited zero without a guest BUILD_ID" };
  stages.buildID = buildID;
  stages.fixtureAfterApplication = await fixtureSnapshot(page, "after-application");
  assert.deepEqual(external, []);
  assert.deepEqual(registry.misses, []);
} catch (error) {
  stages.failure = String(error);
} finally {
  clearTimeout(timer);
  const mirror = registry ? { requests: registry.requests, misses: registry.misses } : null;
  try { await registry?.close(); } finally { await task.cleanup(); }
  writeFileSync(join(reports, "browser-results.json"), JSON.stringify({ guest: receipt, guestReceipt, expectedGuest, stages, mirror, offlineMetadata, external, cleanup: true }, null, 2));
}
process.stdout.write(JSON.stringify(stages, null, 2) + "\n");
if (Object.values(stages).some(value => value && typeof value === "object" && "status" in value && value.status !== "pass") || stages.failure) process.exitCode = 1;
