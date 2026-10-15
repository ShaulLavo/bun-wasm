#!/usr/bin/env node
// Export a real dependency graph, restore it in another guest, then edit the app.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const launcher = process.env.BUN_WASM_LAUNCHER || `${process.env.CARGO_TARGET_DIR || "/work/tmp/bun-wasm-target"}/release/bun-wasm`;
const roundtripOnly = process.argv.includes("--roundtrip-only");
const engines = process.argv.slice(2).filter((argument) => argument !== "--roundtrip-only");
if (!engines.length) engines.push("quickjs");
let scratch;
let child;
let socket;

async function stop() {
  socket?.close();
  socket = null;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  assert.equal(await readlink(`/proc/${child.pid}/cwd`), root);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  child = null;
}

async function cleanup() {
  await stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().finally(() => process.exit(130)));
const deadline = setTimeout(() => {
  console.error("Dependency cache checks exceeded 180 seconds");
  void cleanup().finally(() => process.exit(1));
}, 180000);

const app = 'import { message } from "cache-dep"; document.body.textContent = message + " app before";\n';
async function packages(broken = false) {
  const directory = join(scratch, "node_modules/cache-dep");
  await writeFile(join(directory, "index.js"), broken ? "const broken: = ;" : 'import { leaf } from "./leaf.js"; export const message = "cached dependency " + leaf;\n');
  await writeFile(join(directory, "leaf.js"), broken ? "const broken: = ;" : 'export const leaf = "survives warm startup";\n');
}

async function start(engine) {
  const wasm = resolve(root, `dist/${engine === "quickjs" ? "bun" : `bun-${engine}`}.wasm`);
  const common = ["--wasm", wasm, "--dir", `${scratch}::/`, "--env", "PWD=/", "--env", "PORT=0", "--env", "BUN_WASM_STARTUP=1"];
  const command = engine === "browser" ? process.execPath : launcher;
  const args = engine === "browser"
    ? [resolve(root, "web/scripts/node-host.mjs"), "--net"].concat(common, ["--", "/page.html"])
    : common.concat(["/page.html"]);
  child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const state = { logs: "", url: "" };
  const started = new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`Dependency cache startup timed out: ${state.logs}`)), 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Dependency cache guest exited ${code}: ${state.logs}`)); });
    child.stdout.on("data", (bytes) => {
      state.logs += bytes;
      const match = /Started development server: (http:\/\/\S+)/.exec(state.logs);
      if (!match) return;
      state.url = match[1];
      clearTimeout(timer);
      ready(state);
    });
  });
  child.stderr.on("data", (bytes) => { state.logs += bytes; });
  return started;
}

async function bundle(state) {
  const html = await (await fetch(state.url)).text();
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert(script, `No emitted script: ${state.logs}`);
  return (await fetch(new URL(script, state.url))).text();
}

function connect(url) {
  socket = new WebSocket(new URL("/_bun/hmr", url.replace(/^http/, "ws")));
  socket.binaryType = "arraybuffer";
  const messages = [];
  socket.addEventListener("message", (event) => messages.push(new Uint8Array(event.data)));
  return async (type) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      const index = messages.findIndex((bytes) => bytes[0] === type.charCodeAt(0));
      if (index !== -1) return messages.splice(index, 1)[0];
      await new Promise((ready) => setTimeout(ready, 20));
    }
    throw new Error(`No Bun ${type} frame`);
  };
}

const u32 = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; };
const field = (value) => { const bytes = Buffer.from(value); return Buffer.concat([u32(bytes.length), bytes]); };

function invalidCaches(cache) {
  const headerLength = 12 + cache.readUInt32LE(8) + 16;
  const header = cache.subarray(0, headerLength);
  const path = field("/node_modules/cache-dep/leaf.js");
  const node = (map, imports = [0]) => Buffer.concat([path, field("0"), Buffer.from([0]), map, u32(imports.length)].concat(imports.map(u32)));
  const payload = (value) => Buffer.concat([header, u32(1), value]);
  const mapped = (mappings, source = '"source"', line = 0, column = 0) => Buffer.concat([Buffer.from([2]), field(mappings), field(source), u32(line), u32(column)]);
  return [
    ["truncated payload", cache.subarray(0, cache.length - 1)],
    ["oversized node count", Buffer.concat([header, u32(0xffffffff)])],
    ["sentinel line count", payload(node(Buffer.concat([Buffer.from([1]), u32(0xffffffff)])))],
    ["wrong line count", payload(node(Buffer.concat([Buffer.from([1]), u32(1000)])))],
    ["invalid VLQ digit", payload(node(mapped("!AAA")))],
    ["incomplete VLQ", payload(node(mapped("gggggggg")))],
    ["overflowing VLQ", payload(node(mapped("//////EAAA")))],
    ["incomplete segment", payload(node(mapped("AAA")))],
    ["negative end state", payload(node(mapped("AAAA", '"source"', 0x80000000)))],
    ["unquoted source contents", payload(node(mapped("AAAA", "source")))],
    ["out-of-range import", payload(node(Buffer.from([0]), [1]))],
    ["duplicate import", payload(node(Buffer.from([0]), [0, 0]))],
  ];
}

async function check(engine) {
  scratch = await mkdtemp("/work/tmp/bun-wasm-dev-cache-");
  await mkdir(join(scratch, "node_modules/cache-dep"), { recursive: true });
  await mkdir(join(scratch, ".bunwasm"));
  await writeFile(join(scratch, "page.html"), '<!doctype html><body><script type="module" src="./app.ts"></script></body>');
  await writeFile(join(scratch, "app.ts"), app);
  await writeFile(join(scratch, "node_modules/cache-dep/package.json"), '{"name":"cache-dep","type":"module","main":"index.js"}');
  await packages();
  const cold = await start(engine);
  const initial = await bundle(cold);
  assert.match(initial, /survives warm startup/);
  const cache = Buffer.from(await (await fetch(new URL("/_bun/deps-cache", cold.url))).arrayBuffer());
  const countOffset = 12 + cache.readUInt32LE(8) + 16;
  assert.equal(cache.readUInt32LE(countOffset), 2, "both package modules must be cached");
  await stop();
  await writeFile(join(scratch, ".bunwasm/deps-cache"), cache);
  // Keep the paths resolvable but make recompilation fail. The warm guest
  // must consume the wrappers compiled by the cold guest.
  await packages(true);
  const warm = await start(engine);
  assert.equal(await bundle(warm), initial, "restored dependency graph changes the emitted bundle");
  assert.match(warm.logs, /deps-cached/);
  const exported = Buffer.from(await (await fetch(new URL("/_bun/deps-cache", warm.url))).arrayBuffer());
  assert.deepEqual(exported, cache, "restoring changes cached maps, code, flags or edge order");
  const next = connect(warm.url);
  await next("V");
  socket.send("she");
  socket.send("n/");
  await next("n");
  await writeFile(join(scratch, "app.ts"), app.replace("app before", "app after"));
  assert.match(new TextDecoder().decode(await next("u")), /app after/);
  assert.match(await bundle(warm), /survives warm startup/);
  await stop();
  await packages();
  await writeFile(join(scratch, "app.ts"), app);
  if (roundtripOnly) return;
  for (const [name, malformed] of invalidCaches(cache)) {
    await writeFile(join(scratch, ".bunwasm/deps-cache"), malformed);
    const state = await start(engine);
    assert.match(state.logs, /Discarded invalid dependency cache/, name);
    assert.equal(await bundle(state), initial, `${name} must recover with a cold build`);
    await stop();
  }
  const empty = Buffer.concat([cache.subarray(0, countOffset), u32(0)]);
  await writeFile(join(scratch, ".bunwasm/deps-cache"), empty);
  const state = await start(engine);
  assert(!state.logs.includes("Discarded invalid"), "a zero-module cache is valid");
  assert.equal(await bundle(state), initial);
}

try {
  for (const engine of engines) {
    try {
      await check(engine);
      console.log(`PASS ${engine}: two cached modules, identical code/maps/edges, source bypass and HMR${roundtripOnly ? "" : ", 12 malformed caches and empty cache"}`);
    } finally { await cleanup(); }
  }
} finally { clearTimeout(deadline); await cleanup(); }
