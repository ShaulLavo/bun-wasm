import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserEntries } from "../../scripts/browser-build.ts";
import { browserType } from "./browser-type.ts";
import type { Browser } from "playwright";

const root = resolve(import.meta.dir, "../..");
const artifact = resolve(process.env.BUN_WASM_TRANSFER_ARTIFACT ?? join(root, "dist/bun-browser.wasm"));
assert.ok(existsSync(artifact), `Browser-native guest required: ${artifact}`);
const fixture = join(root, "tests/fixtures/worker-wasm");
assert.ok(existsSync(join(fixture, "node_modules/@emnapi/core/package.json")), "Install pinned fixture dependencies with bun install --cwd tests/fixtures/worker-wasm --frozen-lockfile");
const scratch = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "bw-wasm-"));
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return cleanupPromise ??= (async () => {
    try { await browser?.close(); }
    finally { server?.stop(true); await rm(scratch, { recursive: true, force: true }); }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("Wasm transfer gate timed out"); void cleanup().finally(() => process.exit(1)); }, 120_000);
let port: number | undefined;
try {
  const out = join(scratch, "dist");
  await buildBrowserEntries([join(root, "web/tests/wasm-transfer-page.ts"), join(root, "web/src/worker.ts"), join(root, "web/src/fs-worker.ts")], out, { runtimeWorker: true });
  await Bun.write(join(out, "index.html"), '<!doctype html><script type="module" src="./wasm-transfer-page.js"></script>');
  const worker = await Bun.build({ entrypoints: [join(fixture, "worker.ts")], target: "browser", format: "esm", external: ["node:*"], minify: false });
  assert.ok(worker.success, String(worker.logs));
  const files = await Promise.all(["index.ts", "atomic-module.ts"].map(async path => ({ path, source: await Bun.file(join(fixture, path)).text() })));
  files.push({ path: "worker.ts", source: await worker.outputs[0]!.text() });
  await Bun.write(join(out, "fixture.json"), JSON.stringify(files));
  const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
  server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.BUN_WASM_TRANSFER_PORT ?? "0"), reusePort: false, fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/bun-guest.wasm") return new Response(Bun.file(artifact), { headers: { ...headers, "Content-Type": "application/wasm" } });
    if (pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    const path = resolve(out, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(out + "/") || !existsSync(path)) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  port = server.port;
  console.log(JSON.stringify({ resources: { existing: { artifact, browserCache: "read only" }, created: { scratch, listener: `127.0.0.1:${port}`, browser: "headless", downloads: "none" } } }));
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]) {
    browser = await browserType(name).launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${port}`);
    await page.waitForFunction(() => Reflect.get(globalThis, "wasmTransferResult"), undefined, { timeout: 90_000 });
    const result = await page.evaluate(() => Reflect.get(globalThis, "wasmTransferResult"));
    console.log(JSON.stringify({ browser: name, version: browser.version(), result, errors }));
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.match(result.stdout, /wasm-transfer-ok wait=ok\/not-equal\/timed-out notify=1 aliases=both-directions emnapi=loaded\/started bytes=65536/);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.sharedBeforeDispose, { clients: 0, objects: 0, waiting: 0 });
    assert.deepEqual(result.cleanup, { clients: 0, objects: 0, waiting: 0 });
    assert.deepEqual(result.transfersBeforeDispose, { pins: 0, attaching: 0 });
    assert.deepEqual(result.transfersAfterDispose, { pins: 0, attaching: 0 });
    assert.equal(result.forcedWorkers, 0);
    assert.equal(result.activeWorkers, 0);
    assert.deepEqual(errors, []);
    await browser.close(); browser = undefined;
  }
} finally {
  clearTimeout(deadline); await cleanup();
  assert.equal(existsSync(scratch), false);
  if (port) assert.equal(await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false), false);
  console.log(JSON.stringify({ cleanup: { scratchRemoved: true, listenerStopped: true, browserClosed: true } }));
}
