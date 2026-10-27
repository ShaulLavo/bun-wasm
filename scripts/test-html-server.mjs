#!/usr/bin/env node
// Direct `bun ./page.html` integration on each engine. Uses only loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = process.env.BUN_WASM_LAUNCHER || `${process.env.CARGO_TARGET_DIR || "/work/tmp/bun-wasm-target"}/release/bun-wasm`;
const engines = process.argv.slice(2);
if (!engines.length) engines.push("quickjs", "jsc", "browser");
let child = null;
async function cleanup() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), root.replace(/\/$/, ""));
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  child = null;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().finally(() => process.exit(130)));
const deadline = setTimeout(() => {
  console.error("HTML server checks exceeded 120 seconds");
  void cleanup().finally(() => process.exit(1));
}, 120000);

async function check(engine) {
  const wasm = resolve(root, `dist/${engine === "quickjs" ? "bun" : `bun-${engine}`}.wasm`);
  const common = ["--wasm", wasm, "--dir", `${root}/tests/fixtures/net-serve-html::/`, "--env", "PWD=/", "--env", "PORT=0"];
  const command = engine === "browser" ? process.execPath : launcher;
  const args = engine === "browser"
    ? [resolve(root, "web/scripts/node-host.mjs"), "--net"].concat(common, ["--", "/page.html"])
    : common.concat(["/page.html"]);
  child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", (bytes) => { output += bytes; });
  const url = await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTML server startup timed out: ${output}`)), 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`HTML server exited ${code}: ${output}`)); });
    child.stdout.on("data", (bytes) => {
      output += bytes;
      const match = /Started development server: (http:\/\/\S+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      ready(match[1]);
    });
  });
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(html, /Vanilla HTML entry/);
  assert(!html.includes("app.ts"));
  const script = /src="([^"]+\.js)"/.exec(html)[1];
  const js = await fetch(new URL(script, url));
  assert.match(js.headers.get("content-type"), /^text\/javascript/);
  const source = await js.text();
  assert.match(source, /hello from bundled TypeScript/);
  const style = /href="([^"]+\.css)"/.exec(html)[1];
  const css = await fetch(new URL(style, url));
  assert.match(css.headers.get("content-type"), /^text\/css/);
  assert.ok((await css.text()).length > 0, "CSS response has content");
  const image = /["']([^"']*\/[^"']+\.png)["']/.exec(source)[1];
  const asset = await fetch(new URL(image, url));
  assert.equal(asset.headers.get("content-type"), "image/png", `Asset ${image} did not resolve`);
  assert.equal(new Uint8Array(await asset.arrayBuffer())[0], 137);
  const head = await fetch(url, { method: "HEAD" });
  assert(Number(head.headers.get("content-length")) > 0);
  assert.equal((await head.text()).length, 0);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.match(await (await fetch(new URL("/client/route", url))).text(), /Vanilla HTML entry/);
}
try {
  for (const engine of engines) {
    try { await check(engine); console.log(`PASS ${engine}: HTML CLI, JS, CSS, image, HEAD, 405, client route`); }
    finally { await cleanup(); }
  }
} finally { clearTimeout(deadline); await cleanup(); }
