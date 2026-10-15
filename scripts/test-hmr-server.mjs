#!/usr/bin/env node
// CLI file edits must reach Bun's incremental graph and its binary HMR protocol.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = process.env.BUN_WASM_LAUNCHER || `${process.env.CARGO_TARGET_DIR || "/work/tmp/bun-wasm-target"}/release/bun-wasm`;
const engines = process.argv.slice(2);
if (!engines.length) engines.push("quickjs", "jsc", "browser");
let scratch = null;
let child = null;
let socket = null;

async function cleanup() {
  if (socket) { socket.close(); socket = null; }
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    assert.equal(await readlink(`/proc/${child.pid}/cwd`), root.replace(/\/$/, ""));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  child = null;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().finally(() => process.exit(130)));
const deadline = setTimeout(() => {
  console.error("HMR server checks exceeded 180 seconds");
  void cleanup().finally(() => process.exit(1));
}, 180000);

async function start(engine) {
  scratch = await mkdtemp("/work/tmp/bun-wasm-hmr-server-");
  await cp(join(root, "tests/fixtures/html-hmr"), scratch, { recursive: true });
  const wasm = resolve(root, `dist/${engine === "quickjs" ? "bun" : `bun-${engine}`}.wasm`);
  const common = ["--wasm", wasm, "--dir", `${scratch}::/`, "--env", "PWD=/", "--env", "PORT=0"];
  const command = engine === "browser" ? process.execPath : launcher;
  const args = engine === "browser"
    ? [resolve(root, "web/scripts/node-host.mjs"), "--net"].concat(common, ["--", "/page.html"])
    : common.concat(["/page.html"]);
  child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", (bytes) => { output += bytes; });
  return new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`HMR server startup timed out: ${output}`)), 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`HMR server exited ${code}: ${output}`)); });
    child.stdout.on("data", (bytes) => {
      output += bytes;
      const match = /Started development server: (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      ready(match[1]);
    });
  });
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
    throw new Error(`No Bun ${type} frame; received ${messages.map((bytes) => String.fromCharCode(bytes[0])).join(",")}`);
  };
}

async function check(engine) {
  const url = await start(engine);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /\.js/);
  const script = /src="([^"]+\.js)"/.exec(html)?.[1];
  assert(script, "Bun did not emit a client bundle");
  const initial = await (await fetch(new URL(script, url))).text();
  assert.match(initial, /before edit/);
  assert.match(initial, /bun:hmr/);
  const next = connect(url);
  const version = await next("V");
  assert.equal(version.length, 17);
  socket.send("she");
  socket.send("n/");
  assert.equal(new DataView((await next("n")).buffer).getUint32(1, true), 0);
  const source = await readFile(join(scratch, "app.ts"), "utf8");
  await writeFile(join(scratch, "app.ts"), source.replace("before edit", "after edit"));
  assert.match(new TextDecoder().decode(await next("u")), /after edit/);
  const rebuilt = await (await fetch(new URL(script, url))).text();
  assert.match(rebuilt, /after edit/);
  await writeFile(join(scratch, "app.ts"), "const message: = ;");
  assert((await next("e")).length > 1, "syntax error must use Bun's overlay payload");
  await writeFile(join(scratch, "app.ts"), source.replace("before edit", "recovered edit"));
  assert.match(new TextDecoder().decode(await next("u")), /recovered edit/);
}

try {
  for (const engine of engines) {
    try {
      await check(engine);
      console.log(`PASS ${engine}: Bun HMR entry, binary handshake, file edit, rebuilt JS, syntax error, recovery`);
    } finally { await cleanup(); }
  }
} finally { clearTimeout(deadline); await cleanup(); }
