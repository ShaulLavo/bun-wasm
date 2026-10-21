import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { entryPort } from "../../examples/frameworks/ports.server";
import { frameworks } from "../../examples/frameworks/names";
import { chromium } from "playwright";
import { nextPageContract } from "./next-framework-contract";
import { stopProcessGroup } from "./next-framework-process";

assert.equal(Bun.version, "1.4.2", "Native control requires Bun 1.4.2");
const reports = resolve(process.env.NEXT_REPORTS ?? "/work/tmp/bun-wasm-next-control");
mkdirSync(reports, { recursive: true });
const fixture = resolve(import.meta.dir, "../../examples/frameworks");
let restoreSource: (() => void) | undefined;
const base = `http://127.0.0.1:${entryPort}`;
let child: ChildProcess | undefined;
let stopping: Promise<void> | undefined;

function stop() {
  stopping ??= stopChild();
  return stopping;
}
async function stopChild() {
  const current = child;
  const restore = restoreSource;
  restoreSource = undefined;
  try { restore?.(); }
  finally { if (current) await stopProcessGroup(current); }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void stop().finally(() => process.exit(130)); });
}

async function start(mode: "dev" | "prod") {
  stopping = undefined;
  child = spawn(process.execPath, ["run", "server.ts", mode], {
    cwd: fixture, detached: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", data => appendFileSync(join(reports, `${mode}.log`), data));
  child.stderr?.on("data", data => appendFileSync(join(reports, `${mode}.log`), data));
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`server ${mode} exited ${child.exitCode}`);
    const response = await fetch(`${base}/api/next`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(200);
  }
  throw new Error(`server ${mode} readiness timeout`);
}

async function mutation(name: string) {
  const path = name === "next" ? "/api/next" : `/api/${name}/items`;
  const response = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${name}-native` }),
  });
  assert.equal(response.status, 201, `${name} POST status`);
  assert.equal(response.headers.get("x-framework"), name);
  assert.deepEqual((await response.json()).items, [`${name}-native`]);
  const get = await fetch(`${base}${path}?q=nested%20query`);
  assert.deepEqual(await get.json(), { items: [`${name}-native`], query: "nested query" });
  if (name === "next") return;
  const denied = await fetch(base + path, { headers: { "x-deny": "1" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("x-framework"), name);
  const invalid = await fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(invalid.status, 400);
  const html = await (await fetch(`${base}/framework/${name}`)).text();
  assert.ok(html.includes(`${name}-native`), `${name} request-time SSR`);
  process.stdout.write(`PASS ${name}: POST/GET/query/header/rejection/SSR\n`);
}

async function hotUpdate(page: import("playwright").Page) {
  const file = join(fixture, "app/page.tsx");
  const source = readFileSync(file, "utf8");
  restoreSource = () => writeFileSync(file, source);
  const sockets: string[] = [];
  page.on("websocket", socket => sockets.push(socket.url()));
  try {
    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "Five frameworks, one Next app", exact: true }).waitFor();
    writeFileSync(file, source.replace("Five frameworks, one Next app", "Native hot update"));
    await page.getByRole("heading", { name: "Native hot update", exact: true }).waitFor({ timeout: 30000 });
    assert.ok(sockets.some(url => url.includes("/_next/webpack-hmr")), "Next HMR socket");
    writeFileSync(join(reports, "native-hmr.json"), JSON.stringify({ status: "pass", sockets }));
  } finally {
    restoreSource();
    restoreSource = undefined;
  }
}

async function forceStopControl() {
  stopping = undefined;
  const source = "const period: number = 1000; process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, period);";
  child = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child?.once("error", reject);
    child?.stdout?.once("data", () => resolve());
  });
  const started = performance.now();
  await stop();
  await stop();
  const duration = performance.now() - started;
  assert.ok(duration >= 4900, `forced stop waited ${duration}ms`);
  assert.equal(child.signalCode, "SIGKILL");
  writeFileSync(join(reports, "native-forced-stop.json"), JSON.stringify({ status: "pass", duration, signal: child.signalCode }));
}

async function checkUI(mode: "dev" | "prod") {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const responses = await nextPageContract(page, `${base}/`, false);
      writeFileSync(join(reports, `native-${mode}-requests.json`), JSON.stringify(responses, null, 2));
      if (mode === "dev") await hotUpdate(page);
      await page.screenshot({ path: join(reports, `native-${mode}.png`) });
    } finally { await browser.close(); }
}

const slice = process.argv[2] ?? "dev";
if (!["express", "dev", "prod", "cleanup"].includes(slice)) throw new Error("Usage: bun next-framework-native.ts express|dev|prod|cleanup");
try {
  const mode = slice === "prod" ? "prod" : "dev";
  if (slice === "cleanup") {
    await forceStopControl();
    process.exit(0);
  }
  await start(mode);
  if (slice === "express") {
    await mutation("express");
  } else {
    for (const name of frameworks) await mutation(name);
    await mutation("next");
    await checkUI(mode);
    assert.equal((await fetch(`${base}/framework/unknown`)).status, 404);
    assert.equal(await (await fetch(`${base}/probe.txt`)).text(), "framework asset\n");
  }
  writeFileSync(join(reports, `native-${mode}.json`), JSON.stringify({ status: "pass", slice, bun: Bun.version }));
} finally {
  await stop();
  await stop();
}
