import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stopProcessGroup } from "../web/tests/next-framework-process.ts";

type SpiderMonkeyTier = "interp" | "pbl";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  assert.ok(value && !value.startsWith("--"), `${name} needs a value`);
  return value;
}

function spiderMonkeyTier(value: string | undefined): SpiderMonkeyTier {
  assert.ok(value === "interp" || value === "pbl", "SpiderMonkey requires --tier interp or pbl");
  return value;
}

const engine = process.argv[2];
assert.ok(engine === "quickjs" || engine === "jsc" || engine === "browser" || engine === "spidermonkey");
const output = resolve(process.argv[3] ?? `/work/tmp/bun-wasm-http-lifecycle-${engine}`);
const extra = process.argv.slice(4);
const requestedWasm = optionValue(extra, "--wasm");
const tier = engine === "spidermonkey" ? spiderMonkeyTier(optionValue(extra, "--tier")) : undefined;
if (engine === "spidermonkey") assert.ok(requestedWasm, "SpiderMonkey requires explicit --wasm CORE");
await mkdir(output, { recursive: true });
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address();
assert.ok(address && typeof address === "object");
const port = address.port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const root = resolve(import.meta.dir, "..");
const wasm = resolve(requestedWasm ?? resolve(root, "dist", engine === "browser" ? "bun-browser.wasm" : engine === "jsc" ? "bun-jsc.wasm" : "bun.wasm"));
const launcher = engine === "browser" ? "node" : process.env.BUN_WASM_LAUNCHER;
assert.ok(launcher, "Set BUN_WASM_LAUNCHER to the native launcher for QuickJS, JSC, or SpiderMonkey networking");
const prefix = engine === "browser" ? [resolve(root, "web/scripts/node-host.mjs"), "--net"] : [];
const native = engine === "spidermonkey" ? [
  "--engine", `spidermonkey=${wasm}`,
  "--shell", process.env.BUN_WASM_SHELL ?? "",
  "--env-utility", process.env.BUN_WASM_ENV_UTILITY ?? "",
  "--env", `BUN_WASM_SPIDERMONKEY_TIER=${tier}`,
] : [];
if (engine === "spidermonkey") {
  assert.ok(process.env.BUN_WASM_SHELL, "SpiderMonkey requires explicit BUN_WASM_SHELL");
  assert.ok(process.env.BUN_WASM_ENV_UTILITY, "SpiderMonkey requires explicit BUN_WASM_ENV_UTILITY");
}
const args = prefix.concat(["--wasm", wasm], native, ["--dir", root, "--env", `PORT=${port}`, "--", "run", resolve(root, "tests/fixtures/http-response-lifecycle/index.ts")]);
const child = spawn(launcher, args, {
  cwd: root,
  detached: true,
  env: engine === "spidermonkey" ? { ...process.env, BUN_WASM_SPIDERMONKEY_TIER: tier } : undefined,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", chunk => { log += String(chunk); });
child.stderr.on("data", chunk => { log += String(chunk); });
let stopping: Promise<void> | undefined;
const stop = () => stopping ??= stopProcessGroup(child);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void stop().finally(() => process.exit(130)); });
const base = `http://127.0.0.1:${port}`;
const results: { path: string; status: string }[] = [];
async function read(path: string): Promise<string> {
  return await (await fetch(base + path, { headers: { connection: "close" }, signal: AbortSignal.timeout(5000) })).text();
}
async function halfClosed(path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let bytes = "";
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.setTimeout(3000, () => socket.destroy(new Error("half-close response timed out")));
    socket.once("connect", () => socket.end(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`));
    socket.on("data", chunk => { bytes += String(chunk); });
    socket.once("error", reject);
    socket.once("close", () => resolve(bytes));
  });
}
async function halfCloseCases(): Promise<void> {
  const complete = await halfClosed("/half-close-promise");
  assert.match(complete, /^HTTP\/1.1 200 /);
  assert.ok(complete.endsWith("complete"));
  assert.equal(await read("/ok"), "alive");
  results.push({ path: "/half-close-promise", status: "complete response; recovery passed" });
  assert.equal(await halfClosed("/half-close-timer"), "");
  assert.equal(await read("/ok"), "alive");
  results.push({ path: "/half-close-timer", status: "closed before delayed output; recovery passed" });
}
async function terminated(path: string): Promise<void> {
  let failed = false;
  try { await read(path); } catch (error) {
    assert.ok(error instanceof TypeError, `${path}: expected network failure, got ${error}`);
    failed = true;
  }
  assert.ok(failed, `${path} should terminate without a complete body`);
  assert.equal(await read("/ok"), "alive", `recovery after ${path}`);
  results.push({ path, status: "terminated; recovery passed" });
}
try {
  const until = Date.now() + 30000;
  while (!/^HTTP_LIFECYCLE_READY\s*$/m.test(log) && Date.now() < until) {
    assert.equal(child.exitCode, null, log);
    await Bun.sleep(25);
  }
  assert.ok(/^HTTP_LIFECYCLE_READY\s*$/m.test(log), log);
  for (const path of ["/before", "/headers", "/twice", "/late-end", "/output-error"]) await terminated(path);
  const response = await fetch(base + "/cancel", { headers: { connection: "close" }, signal: AbortSignal.timeout(5000) });
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  await reader.cancel();
  await halfCloseCases();
  let events = JSON.parse(await read("/events"));
  const cancelledUntil = Date.now() + 3000;
  while (events.producers && Date.now() < cancelledUntil) { await Bun.sleep(25); events = JSON.parse(await read("/events")); }
  assert.equal(events.producers, 0, "cancelled producer cleaned up");
  for (const path of ["/before", "/headers", "/twice", "/late-end", "/output-error", "/cancel"]) {
    assert.deepEqual(events.closed.filter((event: { path: string }) => event.path === path), [{ path, finished: false, destroyed: true }]);
  }
  assert.deepEqual(events.closed.filter((event: { path: string }) => event.path === "/half-close-promise"), [{ path: "/half-close-promise", finished: true, destroyed: true }]);
  assert.deepEqual(events.closed.filter((event: { path: string }) => event.path === "/half-close-timer"), [{ path: "/half-close-timer", finished: false, destroyed: true }]);
  assert.equal(events.errors.filter((error: { message: string }) => error.message === "deliberate output error").length, 1);
  assert.ok(events.errors.every((error: { message: string; code: string | null }) => error.message === "deliberate output error" || error.code === "ECONNRESET"));
  assert.equal(await read("/ok"), "alive");
  results.push({ path: "/cancel", status: "closed once; producer stopped; recovery passed" });
  await writeFile(resolve(output, "result.json"), JSON.stringify({ engine, status: "pass", results, events }, null, 2));
  console.log(`PASS ${engine}: ${results.length} lifecycle cases and recovery`);
} finally {
  await stop();
  await writeFile(resolve(output, "guest.log"), log);
}
