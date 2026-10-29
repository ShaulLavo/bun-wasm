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
writeFileSync(join(output, "run.json"), "", { flag: "wx" });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const files = Object.fromEntries(["package.json", "bun.lock", "vite.config.ts", "pages/index.tsx", "components/counter.tsx"].map(path => [path, readFileSync(join(fixture, path), "utf8")]));
type Result = { status: "pass" | "fail" | "blocked"; observations?: { stage: string; status: string }[] };
const heading = "Hello from vinext on QuickJS!";
const app = {
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
const rows: { engine: string; host: string; stage: string; status: string }[] = [];
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const browserVersion = execFileSync(chromium.executablePath(), ["--version"], { encoding: "utf8" }).trim();
const assets = Object.fromEntries(["bun.wasm", "quickjs.wasm"].map(name => {
  const path = join(webRoot, name);
  return [name, sha256(existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(`${path}.gz`)))];
}));
const host = await browserHost({ root, options: { output, timeout: 60000, previewOrigins: true }, launch, stop });
const mirror = nextRegistry(resolve(values["registry-extra"]), 0);
let cleanup = "pending";
let closing: Promise<void> | undefined;
let infrastructureError: string | null = null;
function close(): Promise<void> {
  return closing ??= release();
}
async function release() {
  const results = await Promise.allSettled([host.close(), mirror.close()]);
  for (const child of children) stop(child);
  const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
  cleanup = failures.length ? failures.join("; ") : "pass";
}
process.once("exit", () => { for (const child of children) stop(child); });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close().finally(() => process.exit(130)));
try {
  await host.runApp({ app, engine: "quickjs", registry: mirror.base,
    record(_app: unknown, engine: string, host: string, stage: string, command: string[], result: Result) {
      const row = { engine, host, stage, command, ...result };
      rows.push(row);
      if (stage === "dev") recordDevChecks(engine, host, result);
      writeFileSync(join(output, "results.jsonl"), JSON.stringify(row) + "\n", { flag: "a" });
      process.stdout.write(JSON.stringify(row) + "\n");
      return result;
    },
  });
} catch (error) { infrastructureError = String(error); }
finally {
  await close().catch(error => { cleanup = String(error); });
  writeFileSync(join(output, "run.json"), JSON.stringify({
    runtime: { label: values["runtime-label"], canonical: false, reason: "Diagnostic probe; canonical producer manifest not verified by this driver", webRoot, assets },
    fixture: { sha256: sha256(JSON.stringify(files)), lockSha256: sha256(files["bun.lock"] ?? ""), upstream: JSON.parse(readFileSync(join(fixture, "upstream.json"), "utf8")) },
    browserVersion, rows, infrastructureError, registry: { requests: mirror.requests, misses: mirror.misses }, cleanup,
  }, null, 2) + "\n");
}
if (infrastructureError || cleanup !== "pass" || mirror.misses.length || rows.some(row => row.status !== "pass")) process.exitCode = 1;

function recordDevChecks(engine: string, host: string, result: Result) {
  const observations = result.observations ?? [];
  rows.push({ engine, host, stage: "dev:page", status: result.status === "pass" ? "pass" : "blocked" });
  for (const stage of ["hmr", "reload", "counter"]) {
    const observation = observations.find(item => item.stage === stage);
    rows.push({ engine, host, stage: `dev:${stage}`, status: observation?.status ?? "blocked" });
  }
}
