// Chromium startup timings with CDP CPU throttling. The Python server also works in real Safari.
// PLAYWRIGHT=<index.mjs> node sandbox/tests/startup-profile.mjs --root site/dist --out <directory>
// Each engine gets a fresh context for cold startup, then reloads with persistent browser caches.
import { spawn } from "node:child_process";
import { mkdir, writeFile, readlink, realpath } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback;
const root = resolve(option("root", "site/dist"));
const out = resolve(option("out", "/work/tmp/bun-wasm-startup-profile"));
const shots = resolve(option("shots", out));
const cpu = Number(option("cpu", "6"));
const networkMbps = Number(option("network-mbps", "0"));
const latency = Number(option("latency", "0"));
const engines = option("engines", "browser,quickjs").split(",");
const timeout = Number(option("timeout", "180000"));
const activationDelay = Number(option("activation-delay-ms", "0"));
const requireCache = args.includes("--require-cache");
await mkdir(out, { recursive: true });
await mkdir(shots, { recursive: true });
const server = spawn("python3", [join(dirname(fileURLToPath(import.meta.url)), "profile-server.py"), "--root", root, "--results", out, "--port", "0", "--activation-delay-ms", String(activationDelay)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let browser;
const failures = [];
try {
  const base = await new Promise((resolveURL, reject) => {
    let output = "";
    server.once("error", reject);
    server.once("exit", (code) => reject(new Error(`Profile server exited ${code}`)));
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) resolveURL(JSON.parse(output.split("\n")[0]).url);
    });
  });
  const module = await import(process.env.PLAYWRIGHT ?? "playwright");
  browser = await (module.default ?? module).chromium.launch();
  for (const engine of engines) await profileEngine(engine, base);
} finally {
  await browser?.close();
  await stopProfileServer();
}
if (failures.length) throw new Error(failures.join("\n"));

async function profileEngine(engine, base) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  if (networkMbps) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: networkMbps * 1e6 / 8, uploadThroughput: networkMbps * 1e6 / 8, latency });
  }
  try {
    for (const visit of ["cold", "reload"]) await profileVisit(page, engine, visit, base);
  } finally {
    await context.close();
  }
}

async function profileVisit(page, engine, visit, base) {
  const run = `chromium-${cpu}x-${engine}-${visit}`;
  const url = new URL(base);
  url.searchParams.set("engine", engine);
  url.searchParams.set("profile", run);
  url.searchParams.set("profileUpload", "0");
  if (activationDelay) url.searchParams.set("activationRace", "1");
  await page.goto(url.href);
  try {
    await page.waitForFunction(() => window.__startupProfile?.snapshot().complete, null, { timeout });
  } catch (error) {
    failures.push(`${run}: ${error.message.split("\n")[0]}`);
  }
  const result = await page.evaluate(() => window.__startupProfile.snapshot());
  result.cpuThrottle = cpu;
  result.network = networkMbps ? { mbps: networkMbps, latency } : null;
  const engineCacheHit = result.phases.some((entry) => entry.name === "bunwasm:engine-cache-hit");
  const depsCached = result.phases.some((entry) => entry.name === "bunwasm:deps-cached");
  if (requireCache && visit === "reload" && (!engineCacheHit || !depsCached)) failures.push(`${run}: cache miss, engine=${engineCacheHit} deps=${depsCached}`);
  if (requireCache && visit === "cold" && (engineCacheHit || depsCached)) failures.push(`${run}: cold context unexpectedly reused caches`);
  await writeFile(join(out, `${run}.json`), `${JSON.stringify(result, null, 2)}\n`);
  await page.screenshot({ path: join(shots, `${run}.png`), fullPage: true });
  const compile = result.events.find((event) => event.name === "wasm-compile" || event.name === "wasm-compileStreaming");
  const deps = result.events.find((event) => event.name === "bundle-deps");
  console.log(JSON.stringify({ run, navToRender: result.navToRender, compile: compile?.duration, bundleDeps: deps?.duration, engineCacheHit, depsCached, status: result.status, errors: result.errors }));
}

async function stopProfileServer() {
  if (process.platform === "linux" && server.exitCode === null && await readlink(`/proc/${server.pid}/cwd`) !== await realpath(root)) throw new Error(`Profile server PID ${server.pid} changed its working directory; refusing to kill it`);
  server.kill("SIGTERM");
  await new Promise((resolveExit) => server.exitCode !== null ? resolveExit() : server.once("exit", resolveExit));
}
