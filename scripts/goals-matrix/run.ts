import { readFile, mkdir, writeFile, rmdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve, join } from "node:path";
import { browsers, engines, boxId, frameworks, type Browser, type Engine, type Framework } from "./catalog";
import { initialCells, validateReport, type Report, type Cell } from "./model";
import { saveReport } from "./report";
import { deadlinePolicy, parseInstallTimeouts, parseTimeout, sameDeadlines } from "./deadlines";
import { prerequisites } from "./discovery";
import { execute, bounded } from "./execute";
import { createPlaywrightTransport, type Transport } from "./transport";
import { createSafariTransport } from "./safari-transport";
import { assetIdentity } from "./assets";
import { withNativeDriver } from "./native";
import { withSignals } from "./lifetime";
import { preflight } from "./preparation";
import { nativePlatformBlocker, blockedCell, type PlatformBlocker } from "./platform";

export interface Options {
  signal?: AbortSignal;
  root: string; output: string; timeoutMs: number; installTimeouts: Record<string, number>; browsers: readonly Browser[]; engines: readonly Engine[]; frameworks: readonly string[];
  resume: boolean; retryFailures: boolean; sourceFile?: string; safariEndpoint?: string; iphoneEndpoint?: string; deviceUDID?: string; assetSource: string;
}
function selected<T extends string>(value: string, all: readonly T[]): T[] {
  const names = value.split(",");
  if (names.some(name => !all.some(candidate => candidate === name))) throw new Error(`Unknown selection ${value}; choose ${all.join(",")}`);
  return all.filter(name => names.includes(name));
}
export function options(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match?.[1]) throw new Error(`Expected --name=value, received ${arg}`);
    const allowed = ["root", "output", "timeout-ms", "install-timeout-ms", "browsers", "engines", "frameworks", "resume", "retry-failures", "safari-endpoint", "iphone-endpoint", "device-udid", "asset-source", "source-file"];
    if (!allowed.includes(match[1]) || values.has(match[1])) throw new Error(`Unknown or repeated option ${arg}`);
    values.set(match[1], match[2] ?? "true");
  }
  const timeoutMs = parseTimeout(values.get("timeout-ms") ?? "180000");
  const installTimeouts = parseInstallTimeouts(values.get("install-timeout-ms"));
  const assetSource = values.get("asset-source");
  if (!assetSource) throw new Error("Set --asset-source to the actual WASM source commit or delivery manifest path");
  return {
    root: resolve(values.get("root") ?? "web/dist"), output: resolve(values.get("output") ?? "/work/reports/goals"), timeoutMs, installTimeouts,
    browsers: selected(values.get("browsers") ?? browsers.join(","), browsers), engines: selected(values.get("engines") ?? engines.join(","), engines),
    frameworks: selected(values.get("frameworks") ?? frameworks.map(item => item.id).join(","), frameworks.map(item => item.id)),
    resume: values.has("resume"), retryFailures: values.has("retry-failures"), safariEndpoint: values.get("safari-endpoint"), iphoneEndpoint: values.get("iphone-endpoint"),
    deviceUDID: values.get("device-udid"), assetSource, sourceFile: values.get("source-file"),
  };
}
async function nativeTransport(box: Cell, config: Options): Promise<Transport> {
  if (box.browser !== "safari" && box.browser !== "iphone-safari") throw new Error("Not a native Safari box");
  const endpoint = box.browser === "safari" ? config.safariEndpoint : config.iphoneEndpoint;
  if (!endpoint) throw new Error("Missing native WebDriver endpoint");
  return createSafariTransport({ browser: box.browser, endpoint, deviceUDID: config.deviceUDID, timeoutMs: config.timeoutMs });
}
export async function initialReport(config: Options): Promise<Report> {
  const staged: Report["source"] | undefined = config.sourceFile ? JSON.parse(await readFile(config.sourceFile, "utf8")) : undefined;
  const commit = staged?.commit ?? (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text()).trim();
  const dirty = staged?.dirty ?? Boolean((await new Response(Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" }).stdout).text()).trim());
  const hostSource = await readFile(join(config.root, "goals-host-source.json"), "utf8").then(text => JSON.parse(text)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (hostSource !== null && (!hostSource || typeof hostSource !== "object" || typeof hostSource.commit !== "string" || !/^[a-f0-9]{40}$/.test(hostSource.commit) || typeof hostSource.dirty !== "boolean")) throw new Error("Invalid built host source identity");
  const files = await assetIdentity(config.root);
  if (hostSource === null && files.some(file => /\.wasm(?:\.gz)?$/.test(file.file))) throw new Error("Preparation error: staged host has no built source identity; run goals-matrix/prepare.ts");
  const builds = await readFile(join(config.root, "engine-builds.json"), "utf8").then(text => JSON.parse(text)).catch(error => ({ error: String(error) }));
  const report: Report = { schema: 2, run: crypto.randomUUID(), createdAt: new Date().toISOString(), command: ["source env.sh && bun scripts/goals-matrix/run.ts"].concat(process.argv.slice(2).map(arg => `'${arg.replaceAll("'", "'\\''")}'`)).join(" "), deadlines: deadlinePolicy(config.timeoutMs, config.installTimeouts), source: { commit, dirty, assets: { source: config.assetSource, engineBuilds: builds, hostSource, files } }, cells: initialCells() };
  if (staged && JSON.stringify(staged.assets) !== JSON.stringify(report.source.assets)) throw new Error("Staged assets differ from controller provenance");
  if (!config.resume) return report;
  const previous: unknown = JSON.parse(await readFile(join(config.output, "TABLE.json"), "utf8"));
  validateReport(previous);
  if (!sameDeadlines(previous.deadlines, report.deadlines)) throw new Error("Resume requires the same effective deadline policy; use a new output directory");
  if (previous.source.commit !== commit || previous.source.dirty || dirty || JSON.stringify(previous.source.assets) !== JSON.stringify(report.source.assets)) throw new Error("Resume requires the same clean source commit and asset identity");
  return { ...previous, command: report.command };
}
function selectedCell(cell: Cell, config: Options): boolean {
  if (!config.browsers.includes(cell.browser) || !config.engines.includes(cell.engine) || !config.frameworks.includes(cell.framework)) return false;
  if (cell.status === "pass") return false;
  if (cell.status === "fail" && !config.retryFailures) return false;
  return true;
}
export function playgroundURL(base: string, framework: Framework, engine: Engine): string {
  const url = new URL(base);
  url.searchParams.set("template", framework.template); url.searchParams.set("engine", engine);
  url.searchParams.set("prompt", "off"); url.searchParams.set("mode", "memory");
  if (framework.rootPreview) url.searchParams.set("root-previews", "");
  return url.href;
}
async function runCell(cell: Cell, config: Options, base: string, signal: AbortSignal): Promise<Cell> {
  const missing = prerequisites(cell, config);
  if (missing) return { framework: cell.framework, browser: cell.browser, engine: cell.engine, attempts: cell.attempts, status: "not runnable yet", ...missing };
  const framework = frameworks.find(framework => framework.id === cell.framework);
  if (!framework) throw new Error(`Unknown framework ${cell.framework}`);
  const port = framework.rootPreview ? await availablePort() : 5173;
  return execute({ box: cell, framework, port, url: playgroundURL(base, framework, cell.engine), timeoutMs: config.timeoutMs, installTimeoutMs: config.installTimeouts[cell.framework] ?? config.timeoutMs, signal,
    createTransport: () => cell.browser === "chrome" || cell.browser === "firefox" ? createPlaywrightTransport(cell.browser, config.timeoutMs) : nativeTransport(cell, config),
    saveLog: async text => { await writeFile(join(config.output, "logs", boxId(cell).replaceAll("/", "-") + ".log"), text); },
  }, cell.attempts);
}
async function availablePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
  try {
    if (server.port === undefined) throw new Error("Missing loopback preview port");
    return server.port;
  }
  finally { await server.stop(true); }
}
export async function run(config: Options): Promise<Report> {
  return withSignals(async signal => {
    await mkdir(config.output, { recursive: true });
    const lock = join(config.output, ".goals-matrix-lock");
    await mkdir(lock);
    try { signal.throwIfAborted(); return await runLocked(config, signal); }
    finally { await rmdir(lock); }
  }, config.signal);
}

function seedBlockers(report: Report, blockers: Map<Browser, PlatformBlocker>): void {
  for (const cell of report.cells) {
    const blocker = nativePlatformBlocker(cell);
    if (blocker) blockers.set(cell.browser, blocker);
  }
}
async function runLocked(config: Options, signal: AbortSignal): Promise<Report> {
  await preflight(config.root, config.engines);
  const report = await initialReport(config);
  await mkdir(join(config.output, "logs"), { recursive: true });
  await saveReport(config.output, report);
  signal.throwIfAborted();
  const server = Bun.spawn(["bun", "web/serve.ts"], { env: { ...process.env, ROOT: config.root, HOST: "127.0.0.1", PORT: "0", PREVIEW_ORIGINS: "1" }, stdout: "pipe", stderr: "inherit" });
  const resource = { kind: "asset-server" as const, host: hostname(), pid: server.pid, stopped: false };
  report.resources = (report.resources ?? []).concat([resource]);
  let base = "";
  try {
    const reader = server.stdout.getReader();
    const first = await bounded(() => reader.read(), 10_000); reader.releaseLock();
    base = /at (http:\/\/\S+)/.exec(new TextDecoder().decode(first.value))?.[1] ?? "";
    if (!base) throw new Error("Playground asset server did not publish a URL");
    const blockers = new Map<Browser, PlatformBlocker>();
    if (!config.retryFailures) seedBlockers(report, blockers);
    for (const [index, cell] of report.cells.entries()) {
      if (!selectedCell(cell, config)) continue;
      if (signal.aborted) break;
      const result = blockedCell(cell, blockers) ?? await runCell(cell, config, base, signal);
      report.cells[index] = result;
      const blocker = nativePlatformBlocker(result);
      if (blocker) blockers.set(cell.browser, blocker);
      await saveReport(config.output, report);
      console.log(boxId(cell), report.cells[index]?.status);
    }
  } finally {
    server.kill("SIGTERM"); await server.exited;
    resource.stopped = true;
    await saveReport(config.output, report);
  }
  return report;
}
export async function unavailableReport(config: Options, error: unknown, current?: Report): Promise<Report> {
  const report = current ?? await initialReport(config);
  report.cells = report.cells.map(cell => {
    if (!selectedCell(cell, config) || cell.attempts.length) return cell;
    return { framework: cell.framework, browser: cell.browser, engine: cell.engine, attempts: [], status: "not runnable yet", reason: `Native fleet prerequisite failed: ${String(error)}`, discovery: { error: String(error) } };
  });
  await saveReport(config.output, report);
  return report;
}
if (import.meta.main) {
  const config = options(process.argv.slice(2));
  const automaticNative = process.platform === "darwin" && config.browsers.some(browser => browser === "safari" || browser === "iphone-safari") && !config.safariEndpoint && !config.iphoneEndpoint;
  const report = automaticNative
    ? await withNativeDriver((endpoint, signal) => run({ ...config, signal, safariEndpoint: endpoint, iphoneEndpoint: endpoint }), { desktopSafari: config.browsers.includes("safari"), cleanupFile: join(config.output, "native-cleanup.json") }).catch(async error => {
      if (await Bun.file(join(config.output, "TABLE.json")).exists()) throw error;
      return unavailableReport(config, error);
    })
    : await run(config);
  process.exitCode = report.cells.some(cell => cell.status === "fail") ? 1 : 0;
}
