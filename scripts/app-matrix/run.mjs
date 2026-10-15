import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apps, browserSubset, projectFiles } from "./apps.mjs";
import { registry, sha256 } from "./registry.mjs";
import { checkCommand, checkInstall } from "./checks.mjs";
import { failure, compareEngines } from "./classify.mjs";
import { earlyServerExit } from "./browser.mjs";

const interfaces = readFileSync("/proc/net/dev", "utf8").split("\n").filter(line => line.includes(":"));
if (interfaces.some(line => line.split(":")[0].trim() !== "lo")) throw new Error("Use scripts/app-matrix.sh in its loopback-only network namespace");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const flags = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value = "true"] = arg.split(/=(.*)/s);
  if (!/^--(apps|engines|hosts|cache|output|launcher|timeout|record|reference|help)$/.test(key)) throw new Error(`Unknown option ${key}; use --help`);
  flags.set(key.slice(2), value);
}
if (flags.has("help")) {
  console.log("scripts/app-matrix.sh [--record] [--reference] --cache=/work/cache/bun-wasm-app-matrix --output=/work/reports/bun-wasm-app-matrix/run [--apps=hono,drizzle] [--engines=quickjs,jsc,browser] [--hosts=native,playground] [--timeout=90] [--launcher=PATH]\nDefault is offline replay. --record permits missing npm records to be downloaded. App failures are census results; missing cache records or host artifacts exit nonzero.");
  process.exit(0);
}
const options = {
  cache: resolve(flags.get("cache") ?? "/work/cache/bun-wasm-app-matrix"),
  output: resolve(flags.get("output") ?? "/work/reports/bun-wasm-app-matrix/run"),
  launcher: resolve(flags.get("launcher") ?? join(process.env.CARGO_TARGET_DIR ?? "/work/tmp/bun-wasm-target", "release/bun-wasm")),
  engines: (flags.get("engines") ?? "quickjs,jsc,browser").split(","),
  hosts: (flags.get("hosts") ?? "native,playground").split(","),
  timeout: Number(flags.get("timeout") ?? 90) * 1000,
  record: flags.has("record"), reference: flags.has("reference"),
};
if (!Number.isFinite(options.timeout) || options.timeout < 1000) throw new Error("--timeout must be at least one second");
for (const engine of options.engines) if (!["quickjs", "jsc", "browser"].includes(engine)) throw new Error(`Unknown engine ${engine}`);
for (const host of options.hosts) if (!["native", "playground"].includes(host)) throw new Error(`Unknown host ${host}`);
const requested = flags.has("apps") ? flags.get("apps").split(",") : apps.map(app => app.id);
for (const id of requested) if (!apps.some(app => app.id === id)) throw new Error(`Unknown app ${id}`);
const selected = apps.filter(app => requested.includes(app.id));
const wasmName = { quickjs: "bun.wasm", jsc: "bun-jsc.wasm", browser: "bun-browser.wasm" };
for (const engine of options.engines) if (!existsSync(join(root, "dist", wasmName[engine]))) throw new Error(`Build dist/${wasmName[engine]} first`);
if (options.hosts.includes("native") && options.engines.some(engine => engine !== "browser") && !existsSync(options.launcher)) throw new Error(`Build launcher ${options.launcher} first`);
if (options.hosts.includes("playground") && !existsSync(join(root, "web/dist/index.html"))) throw new Error("Build web/ first");
if (existsSync(join(options.output, "results.json"))) throw new Error("Results already exist; choose another --output");
mkdirSync(options.output, { recursive: true });
const scratch = mkdtempSync(join(process.env.MATRIX_SCRATCH_ROOT ?? "/work/tmp", "bun-wasm-app-matrix-run-"));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void cleanup().then(() => process.exit(130)));
process.on("exit", () => {
  for (const child of children) stop(child);
  rmSync(scratch, { recursive: true, force: true });
});

let artifacts = {};
let launcher;
let launcherDigest;
let runnerSources = {};
let playgroundBuilds;
const children = new Set();
let results = [];
let mirror;
let browserSession;
let cleaned = false;

function stop(child) {
  if (!children.delete(child)) return;
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await Promise.allSettled([browserSession?.close(), mirror?.close()]);
  const exited = Array.from(children, child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("close", resolve)));
  for (const child of children) stop(child);
  await Promise.allSettled(exited);
  rmSync(scratch, { recursive: true, force: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = path => existsSync(path) ? readFileSync(path, "utf8") : "";
function launch(argv, cwd, logfile, env = {}) {
  const fd = openSync(logfile, "w");
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.add(child);
  const done = new Promise(resolve => {
    child.once("error", error => resolve({ code: null, error: String(error) }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

async function capture(argv, cwd, logfile, env = {}) {
  const proc = launch(argv, cwd, logfile, env);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(proc.child); }, options.timeout);
  const result = await proc.done;
  clearTimeout(timer);
  stop(proc.child);
  return { ...result, timedOut, output: text(logfile) };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function guestCommand(engine, project, args, port) {
  const env = { PWD: "/", HOME: "/", TMPDIR: "/tmp", PORT: String(port), NO_COLOR: "1", CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1", PRISMA_ENGINES_MIRROR: `${mirror.base}/blocked-prisma-engines`, BUN_INSTALL_CACHE_DIR: "/.cache" };
  const dirs = ["--dir", `${project}::/`];
  const vars = Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const wasm = artifacts[engine].path;
  const host = engine === "browser" ? ["node", "--no-warnings", join(root, "web/scripts/node-host.mjs"), "--net", "--wasm", wasm] : [launcher, "--wasm", wasm];
  return host.concat(dirs, vars, ["--"], args);
}

function record(app, engine, host, stage, command, result) {
  const row = { app: app.id, versions: app.dependencies, engine, host, stage, command: command.join(" "), ...result };
  results.push(row);
  writeFileSync(join(options.output, "results.jsonl"), JSON.stringify(row) + "\n", { flag: "a" });
  console.log(`${row.status.padEnd(7)} ${app.id}/${engine}/${host}/${stage}${row.blocker ? ` ${row.blocker}` : ""}`);
  return row;
}

function prepare(app, name) {
  const project = join(scratch, name);
  mkdirSync(join(project, "tmp"), { recursive: true });
  for (const [path, contents] of Object.entries(projectFiles(app, mirror.base))) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), contents);
  }
  return project;
}

async function checkPage(url, check) {
  try { return await browserSession.checkPage(url, check); }
  catch (error) { return { status: "fail", ...failure(String(error), "server") }; }
}

async function checkServer(proc, url, check, logfile) {
  const deadline = Date.now() + options.timeout;
  while (Date.now() < deadline && proc.child.exitCode === null && proc.child.signalCode === null) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let result;
      if (check.kind === "page") result = await checkPage(url, check);
      else if ((await response.text()).includes(check.text)) result = { status: "pass", assertion: `HTTP ${response.status}, body contains ${JSON.stringify(check.text)}` };
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) return earlyServerExit({ code: proc.child.exitCode ?? proc.child.signalCode, output: text(logfile) }, "server");
      if (result) return result;
    } catch { /* The server may still be starting. */ }
    await sleep(100);
  }
  return { status: "fail", ...failure(text(logfile), "server"), output: text(logfile) };
}

async function execute(app, engine, project, command, native = false) {
  const port = await freePort();
  const args = command.args.map(arg => arg.replaceAll("{port}", String(port)));
  const logfile = join(options.output, `${app.id}-${engine}-${command.name}.log`);
  const argv = native ? ["bun"].concat(args) : guestCommand(engine, project, args, port);
  const env = { PORT: String(port), CI: "1", NEXT_TELEMETRY_DISABLED: "1", ASTRO_TELEMETRY_DISABLED: "1", PRISMA_ENGINES_MIRROR: `${mirror.base}/blocked-prisma-engines` };
  if (["http", "page"].includes(command.check.kind)) {
    const proc = launch(argv, project, logfile, env);
    try { return await checkServer(proc, `http://127.0.0.1:${port}/`, command.check, logfile); }
    finally { stop(proc.child); await proc.done; }
  }
  const result = await capture(argv, project, logfile, env);
  return checkCommand(command, result, path => text(join(project, path)));
}

async function nativeApp(app, engine, reference = false) {
  const project = prepare(app, `${app.id}-${engine}`);
  const logfile = join(options.output, `${app.id}-${engine}-install.log`);
  const args = ["install"];
  const argv = reference ? ["bun", "install", "--ignore-scripts", "--linker", "hoisted", "--registry", mirror.base] : guestCommand(engine, project, args, 0);
  const installed = await capture(argv, project, logfile, { BUN_INSTALL_CACHE_DIR: join(project, ".native-cache"), DO_NOT_TRACK: "1" });
  const install = record(app, engine, "native", "install", ["bun"].concat(args), await checkInstall(app, installed, path => text(join(project, path))));
  const outcomes = new Map();
  for (const command of app.commands) {
    const prerequisite = command.after && outcomes.get(command.after);
    let result;
    if (install.status !== "pass") result = { status: "blocked", category: install.category, blocker: install.blocker, prerequisite: "install" };
    else if (prerequisite && prerequisite.status !== "pass") result = { status: "blocked", category: prerequisite.category, blocker: prerequisite.blocker, prerequisite: command.after };
    else result = await execute(app, engine, project, command, reference);
    outcomes.set(command.name, result);
    record(app, engine, "native", command.name, ["bun"].concat(command.args), result);
  }
  rmSync(project, { recursive: true, force: true });
}

function report(provenance) {
  results = compareEngines(results);
  writeFileSync(join(options.output, "results.jsonl"), results.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(options.output, "results.json"), JSON.stringify({ provenance, results }, null, 2) + "\n");
  const lines = ["# App matrix run", "", "| App | Version | Command | Engine / host | Result | First blocker | Category | Reproducer |", "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of results) {
    const versions = Object.entries(row.versions).map(([name, version]) => `${name}@${version}`).join(", ");
    const safe = value => String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
    lines.push(`| ${row.app} | ${versions} | \`${row.command}\` | ${row.engine} / ${row.host} | ${row.status} | ${safe(row.blocker)} | ${row.category ?? "-"} | [fixture](../../scripts/app-matrix/apps.mjs) |`);
  }
  writeFileSync(join(options.output, "matrix.md"), lines.join("\n") + "\n");
}

let infrastructureError;
try {
  artifacts = Object.fromEntries(options.engines.map(engine => {
    const path = join(scratch, wasmName[engine]);
    copyFileSync(join(root, "dist", wasmName[engine]), path);
    return [engine, { path, sha256: sha256(readFileSync(path)) }];
  }));
  launcher = join(scratch, "bun-wasm");
  if (existsSync(options.launcher)) copyFileSync(options.launcher, launcher);
  launcherDigest = existsSync(launcher) ? sha256(readFileSync(launcher)) : null;
  runnerSources = Object.fromEntries(["run.mjs", "apps.mjs", "registry.mjs", "browser.mjs", "checks.mjs", "classify.mjs", "isolate.mjs"].map(path => [path, sha256(readFileSync(join(root, "scripts/app-matrix", path)))]));
  playgroundBuilds = existsSync(join(root, "web/dist/engine-builds.json")) ? JSON.parse(readFileSync(join(root, "web/dist/engine-builds.json"), "utf8")) : null;
  mirror = await registry({ directory: options.cache, record: options.record });
  const { browserHost } = await import("./browser.mjs");
  browserSession = await browserHost({ root, scratch, options, launch, stop });
  for (const app of selected) {
    if (options.reference || options.record) await nativeApp(app, "reference", true);
    if (options.hosts.includes("native")) for (const engine of options.engines) await nativeApp(app, engine);
    if (options.hosts.includes("playground") && browserSubset.includes(app.id)) {
      for (const engine of options.engines) await browserSession.runApp({ app, engine, registry: mirror.base, record });
    }
  }
} catch (error) {
  infrastructureError = String(error.stack ?? error);
  console.error(infrastructureError);
} finally {
  try {
    const revision = await capture(["git", "rev-parse", "HEAD"], root, join(options.output, "revision.log"));
    report({ date: new Date().toISOString(), revision: revision.output.trim(), nativeBun: Bun.version, options,
      fixtures_sha256: runnerSources["apps.mjs"],
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([engine, artifact]) => [engine, artifact.sha256])),
      runner_sources: runnerSources,
      playground_builds: playgroundBuilds,
      launcher_sha256: launcherDigest,
      registry: mirror?.snapshot(), infrastructureError });
  } finally { await cleanup(); }
}
const counts = Object.fromEntries(["pass", "fail", "blocked"].map(status => [status, results.filter(row => row.status === status).length]));
console.log(JSON.stringify({ counts, output: options.output, cleanup: !existsSync(scratch), registry: mirror?.snapshot() }));
process.exitCode = infrastructureError || mirror?.misses.length || mirror?.errors.length ? 1 : 0;
