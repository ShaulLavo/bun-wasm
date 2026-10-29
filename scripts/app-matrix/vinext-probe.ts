import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import type { ProductCommand } from "./product-types";
import { browserHost } from "./browser.mjs";
import { nextRegistry } from "../../web/tests/next-framework-registry";

const { values } = parseArgs({ options: {
  "web-root": { type: "string" }, "registry-extra": { type: "string" },
  output: { type: "string" }, "runtime-label": { type: "string" },
} });
if (!values["web-root"] || !values["registry-extra"] || !values.output || !values["runtime-label"]) {
  throw new Error("Usage: bun scripts/app-matrix/vinext-probe.ts --web-root PATH --registry-extra PATH --output PATH --runtime-label LABEL");
}
const root = resolve(import.meta.dir, "../..");
const fixture = join(root, "examples/vinext-probe");
const output = resolve(values.output);
const webRoot = resolve(values["web-root"]);
mkdirSync(output, { recursive: true });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type Result = { status: "pass" | "fail" | "blocked"; observations?: { stage: string; status: string }[]; blocker?: string };
type Row = Result & { engine: string; host: string; stage: string; command?: string[] };
const stages = ["setup", "install", "dev", "dev:page", "dev:hmr", "dev:reload", "dev:counter", "build", "start", "runner"];
const rows = new Map<string, Row>(stages.map(stage => [stage, { engine: "quickjs", host: "playground", stage, status: "blocked", blocker: "Not run" }]));
const assets: Record<string, string> = {};
let fixtureIdentity: { sha256: string; lockSha256: string; upstream: unknown } | null = null;
let browserVersion: string | null = null;
let host: Awaited<ReturnType<typeof browserHost>> | undefined;
let mirror: ReturnType<typeof nextRegistry> | undefined;
let cleanup = "pending";
let finalizing: Promise<void> | undefined;
let infrastructureError: string | null = null;
let interruption: string | null = null;
const children = new Set<ReturnType<typeof spawn>>();
function launch(argv: string[], cwd: string, logfile: string, env: Record<string, string> = {}) {
  const fd = openSync(logfile, "w");
  const child = spawn(argv[0] ?? "", argv.slice(1), { cwd, env: { ...process.env, ...env, ROOT: webRoot }, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  children.add(child);
  const done = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  return { child, done };
}
function stop(child: ReturnType<typeof spawn>) {
  if (!children.delete(child) || !child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; }
}

function report() {
  return {
    runtime: { label: values["runtime-label"], canonical: false, reason: "Diagnostic probe; canonical producer manifest not verified by this driver", webRoot, assets },
    fixture: fixtureIdentity, browserVersion, rows: Array.from(rows.values()), infrastructureError,
    registry: { requests: mirror?.requests ?? [], misses: mirror?.misses ?? [] }, cleanup,
  };
}
function save() {
  writeFileSync(join(output, "run.json"), JSON.stringify(report(), null, 2) + "\n");
  writeFileSync(join(output, "results.jsonl"), Array.from(rows.values(), row => JSON.stringify(row) + "\n").join(""));
}
function result(stage: string, outcome: Result, command?: string[]) {
  rows.set(stage, { engine: "quickjs", host: "playground", stage, command, ...outcome });
}
function fail(error: unknown) {
  if (interruption) return;
  infrastructureError = String(error);
  if (rows.get("setup")?.status !== "pass") result("setup", { status: "fail", blocker: infrastructureError });
  result("runner", { status: "fail", blocker: infrastructureError });
}
function finalize(): Promise<void> { return finalizing ??= finish(); }
async function finish() {
  save();
  try { await release(); }
  catch (error) { cleanup = String(error); }
  save();
}
async function release() {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => host?.close()),
    Promise.resolve().then(() => mirror?.close()),
  ]);
  const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  for (const child of children) {
    try { stop(child); }
    catch (error) { failures.push(String(error)); }
  }
  cleanup = failures.length ? failures.join("; ") : "pass";
}
function assetDigest(name: string): string {
  const plain = join(webRoot, name);
  const gzip = `${plain}.gz`;
  if (!existsSync(gzip)) return sha256(readFileSync(plain));
  const bytes = gunzipSync(readFileSync(gzip));
  if (existsSync(plain) && !bytes.equals(readFileSync(plain))) throw new Error(`Asset payload mismatch: ${name} and ${name}.gz`);
  return sha256(bytes);
}
function record(_app: unknown, engine: string, host: string, stage: string, command: string[], checked: Result) {
  if (finalizing) return checked;
  const row = { engine, host, stage, command, ...checked };
  rows.set(stage, row);
  if (stage === "dev") recordDevChecks(checked);
  save();
  process.stdout.write(JSON.stringify(row) + "\n");
  return checked;
}
function recordDevChecks(checked: Result) {
  const observations = checked.observations ?? [];
  result("dev:page", { status: checked.status === "pass" ? "pass" : "blocked", blocker: checked.blocker });
  for (const stage of ["hmr", "reload", "counter"]) {
    const observation = observations.find(item => item.stage === stage);
    const status = observation?.status === "pass" ? "pass" : observation?.status === "fail" ? "fail" : "blocked";
    result(`dev:${stage}`, { status, blocker: observation ? undefined : "Dev checks not reached" });
  }
}
async function main() {
  for (const name of ["bun.wasm", "quickjs.wasm"]) assets[name] = assetDigest(name);
  const files = Object.fromEntries(["package.json", "bun.lock", "vite.config.ts", "pages/index.tsx", "components/counter.tsx"].map(path => [path, readFileSync(join(fixture, path), "utf8")]));
  fixtureIdentity = { sha256: sha256(JSON.stringify(files)), lockSha256: sha256(files["bun.lock"] ?? ""), upstream: JSON.parse(readFileSync(join(fixture, "upstream.json"), "utf8")) };
  const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
  browserVersion = execFileSync(chromium.executablePath(), ["--version"], { encoding: "utf8" }).trim();
  host = await browserHost({ root, options: { output, timeout: 60000, previewOrigins: true }, launch, stop });
  mirror = nextRegistry(resolve(values["registry-extra"] ?? ""), 0);
  result("setup", { status: "pass" });
  save();
  await host.runApp({ app: fixtureApp(files), engine: "quickjs", registry: mirror.base, record });
  if (!interruption) result("runner", { status: "pass" });
}
function fixtureApp(files: Record<string, string>) {
  const heading = "Hello from vinext on QuickJS!";
  return {
    id: "vinext-probe", dependencies: JSON.parse(files["package.json"] ?? "{}").dependencies,
    files,
    commands: [
      { name: "dev", args: ["run", "node_modules/vite/bin/vite.js", "dev", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"], check: { kind: "page", selector: "h1", text: heading, hmr: { path: "pages/index.tsx", search: heading, replacement: "vinext edit confirmed" }, probes: [
        { kind: "route", id: "reload", path: "/", selector: "h1", text: heading },
        { kind: "action", id: "counter", path: "/", button: "#increment", selector: "#count", text: "1" },
      ] } },
      { name: "build", args: ["run", "node_modules/vite/bin/vite.js", "build"], check: { kind: "files", paths: ["dist/server/entry.js"], text: "" } },
      { name: "start", after: "build", args: ["run", "node_modules/vinext/dist/cli.js", "start", "--hostname", "127.0.0.1", "--port", "{port}"], check: { kind: "page", selector: "h1", text: heading } },
    ] satisfies ProductCommand[],
  };
}

writeFileSync(join(output, "run.json"), JSON.stringify(report(), null, 2) + "\n", { flag: "wx" });
process.once("exit", () => { for (const child of children) stop(child); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interruption = `Interrupted by ${signal}`;
  infrastructureError = interruption;
  result("runner", { status: "fail", blocker: interruption });
  void finalize().finally(() => process.exit(130));
});
try { await main(); }
catch (error) { fail(error); }
finally { await finalize(); }
if (infrastructureError || cleanup !== "pass" || mirror?.misses.length || Array.from(rows.values()).some(row => row.status !== "pass")) process.exitCode = 1;
