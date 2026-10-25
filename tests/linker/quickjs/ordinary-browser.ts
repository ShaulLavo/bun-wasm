import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { chromium, type Browser } from "playwright";
import { buildBrowserEntries } from "../../../scripts/browser-build";

const execute = promisify(execFile);
const root = resolve(import.meta.dir, "../../..");
const pair = process.env.BUN_ORDINARY_PAIR;
assert(pair && pair.startsWith("/"), "BUN_ORDINARY_PAIR names retained standard60 artifacts");
const port = Number(process.env.BUN_ORDINARY_PORT);
assert(Number.isInteger(port) && port > 1024 && port < 65536, "explicit free BUN_ORDINARY_PORT");
const binaries = [
  { name: "bun.wasm", bytes: 15398503, sha256: "24bd79657c033294298565597ce1d60b4640d77756b53bae84abd1bf908add56" },
  { name: "quickjs.wasm", bytes: 1058884, sha256: "c64a2336b7d6ed5a8b44824e668bae1f17462e8979c5fb8f1093c6045dd5e977" },
];
let scratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let disposal: Promise<void> | undefined;
async function dispose() {
  try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
  finally { server?.stop(true); if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
function cleanup() { return disposal ??= dispose(); }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("ordinary consumer deadline"); void cleanup().finally(() => process.exit(1)); }, 120_000);
try {
  for (const binary of binaries) {
    const bytes: Uint8Array = await Bun.file(join(pair, binary.name)).bytes();
    assert.equal(bytes.length, binary.bytes);
    assert.equal(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), binary.sha256);
  }
  scratch = await mkdtemp("/work/tmp/bw-ordinary-");
  const consumer = join(scratch, "consumer"), output = join(scratch, "output");
  console.log(JSON.stringify({ resources: { borrowed: { pair, nodeModules: resolve(root, "node_modules"), chromium: chromium.executablePath() }, created: { scratch, port, consumer, output } }, binaries }));
  await mkdir(join(consumer, "node_modules"), { recursive: true });
  await execute(process.execPath, ["pm", "pack", "--destination", consumer, "--quiet"], { cwd: root, timeout: 20_000 });
  const archives = (await readdir(consumer)).filter(name => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const archive = join(consumer, archives[0]!);
  await execute("tar", ["-xzf", archive, "-C", consumer], { timeout: 10_000 });
  await symlink(join(consumer, "package"), join(consumer, "node_modules/bun-wasm"));
  await symlink(resolve(root, "node_modules/waffle"), join(consumer, "node_modules/waffle"));
  for (const [source, name] of [["ordinary-main.ts", "main.ts"], ["ordinary-worker.ts", "worker.ts"], ["ordinary-fs-worker.ts", "fs-worker.ts"]]) {
    assert(source && name);
    await copyFile(join(import.meta.dir, source), join(consumer, name));
  }
  const built = await buildBrowserEntries(["main.ts", "worker.ts", "fs-worker.ts"].map(name => join(consumer, name)), output);
  const inputs = Object.keys(built.metafile.inputs);
  assert(inputs.some(path => path.includes("/package/src/bun-adapter.ts")), "installed Bun adapter input");
  assert(inputs.some(path => path.includes("/package/web/src/worker.ts")), "installed production worker input");
  assert(!inputs.some(path => path.includes("checkpoint-worker")), "no checkpoint worker");
  console.log(JSON.stringify({ bundle: { archiveSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(archive).bytes()).digest("hex"), inputs } }));
  await Bun.write(join(output, "index.html"), '<!doctype html><script type="module" src="./main.js"></script>');
  server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const headers = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "Cache-Control": "no-store" };
    if (pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
    if (binaries.some(binary => pathname === `/${binary.name}`)) return new Response(Bun.file(join(pair, pathname.slice(1))), { headers: { ...headers, "Content-Type": "application/wasm" } });
    if (["/fixtures/main.ts", "/fixtures/value.ts"].includes(pathname)) return new Response(Bun.file(join(import.meta.dir, pathname.slice(1))), { headers });
    const path = resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!path.startsWith(output + sep) || !await Bun.file(path).exists()) return new Response(null, { status: 404, headers });
    return new Response(Bun.file(path), { headers });
  } });
  assert(existsSync(chromium.executablePath()), "cached Chromium");
  launch = chromium.launch({ headless: true }); browser = await launch;
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => Reflect.has(globalThis, "ordinaryRuntime"));
    const result: unknown = await page.evaluate(() => Reflect.get(globalThis, "ordinaryRuntime").run());
    console.log(JSON.stringify({ browser: "chromium", result, errors }));
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), diagnostics: await page.evaluate(() => Reflect.get(globalThis, "ordinaryRuntime")?.diagnostics()).catch(String), errors }));
    throw error;
  } finally {
    const released: unknown = await page.evaluate(() => Reflect.get(globalThis, "ordinaryRuntime")?.cleanup());
    console.log(JSON.stringify({ browserCleanup: released }));
    assert.deepEqual(released, { workers: 0, runtimeDisposed: true, workerConstructorRestored: true });
  }
} finally {
  clearTimeout(deadline); await cleanup();
  assert.equal(scratch ? existsSync(scratch) : false, false);
  const listening = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end(); } } }).then(() => true, () => false);
  assert.equal(listening, false, "owned server port released");
  console.log(JSON.stringify({ hostCleanup: { scratchRemoved: true, browserClosed: !browser?.isConnected(), listenerStopped: true } }));
}
