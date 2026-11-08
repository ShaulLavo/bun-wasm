import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { browsers, engines, boxId, frameworks, type Browser, type Engine } from "./catalog";
import { initialCells, validateReport, type Report, type Cell } from "./model";
import { saveReport } from "./report";
import { prerequisites } from "./discovery";
import { execute } from "./execute";
import { createPlaywrightTransport, type Transport } from "./transport";

export interface Options {
  root: string; output: string; timeoutMs: number; browsers: readonly Browser[]; engines: readonly Engine[]; frameworks: readonly string[];
  resume: boolean; retryFailures: boolean; safariEndpoint?: string; iphoneEndpoint?: string; deviceUDID?: string; assetSource: string;
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
    const allowed = ["root", "output", "timeout-ms", "browsers", "engines", "frameworks", "resume", "retry-failures", "safari-endpoint", "iphone-endpoint", "device-udid", "asset-source"];
    if (!allowed.includes(match[1]) || values.has(match[1])) throw new Error(`Unknown or repeated option ${arg}`);
    values.set(match[1], match[2] ?? "true");
  }
  const timeoutMs = Number(values.get("timeout-ms") ?? "180000");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900_000) throw new Error("timeout-ms must be 100 through 900000");
  const assetSource = values.get("asset-source");
  if (!assetSource) throw new Error("Set --asset-source to the actual WASM source commit or delivery manifest path");
  return {
    root: resolve(values.get("root") ?? "web/dist"), output: resolve(values.get("output") ?? "/work/reports/goals"), timeoutMs,
    browsers: selected(values.get("browsers") ?? browsers.join(","), browsers), engines: selected(values.get("engines") ?? engines.join(","), engines),
    frameworks: selected(values.get("frameworks") ?? frameworks.map(item => item.id).join(","), frameworks.map(item => item.id)),
    resume: values.has("resume"), retryFailures: values.has("retry-failures"), safariEndpoint: values.get("safari-endpoint"), iphoneEndpoint: values.get("iphone-endpoint"),
    deviceUDID: values.get("device-udid"), assetSource,
  };
}
async function nativeTransport(box: Cell, config: Options): Promise<Transport> {
  const modulePath = "./safari-transport.ts";
  const { createSafariTransport } = await import(modulePath);
  return createSafariTransport({ browser: box.browser, endpoint: box.browser === "safari" ? config.safariEndpoint : config.iphoneEndpoint, deviceUDID: config.deviceUDID, timeoutMs: config.timeoutMs });
}
async function initialReport(config: Options): Promise<Report> {
  const commit = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout).text()).trim();
  const dirty = Boolean((await new Response(Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" }).stdout).text()).trim());
  const builds = await readFile(join(config.root, "engine-builds.json"), "utf8").then(text => JSON.parse(text)).catch(error => ({ error: String(error) }));
  const report: Report = { schema: 1, run: crypto.randomUUID(), createdAt: new Date().toISOString(), command: ["source env.sh && bun scripts/goals-matrix/run.ts"].concat(process.argv.slice(2).map(arg => `'${arg.replaceAll("'", "'\\''")}'`)).join(" "), source: { commit, dirty, assets: { source: config.assetSource, engineBuilds: builds } }, cells: initialCells() };
  if (!config.resume) return report;
  const previous: Report = JSON.parse(await readFile(join(config.output, "TABLE.json"), "utf8"));
  validateReport(previous);
  if (previous.source.commit !== commit || previous.source.dirty || dirty || JSON.stringify(previous.source.assets) !== JSON.stringify(report.source.assets)) throw new Error("Resume requires the same clean source commit and asset identity");
  return { ...previous, command: report.command };
}
function selectedCell(cell: Cell, config: Options): boolean {
  if (!config.browsers.includes(cell.browser) || !config.engines.includes(cell.engine) || !config.frameworks.includes(cell.framework)) return false;
  if (cell.status === "pass") return false;
  if (cell.status === "fail" && !config.retryFailures) return false;
  return true;
}
async function runCell(cell: Cell, config: Options, base: string): Promise<Cell> {
  const missing = prerequisites(cell, config);
  if (missing) return { framework: cell.framework, browser: cell.browser, engine: cell.engine, attempts: cell.attempts, status: "not runnable yet", ...missing };
  const framework = frameworks.find(framework => framework.id === cell.framework);
  if (!framework) throw new Error(`Unknown framework ${cell.framework}`);
  const url = new URL(base);
  url.searchParams.set("template", framework.template); url.searchParams.set("engine", cell.engine);
  url.searchParams.set("prompt", "off"); url.searchParams.set("mode", "memory");
  return execute({ box: cell, framework, url: url.href, timeoutMs: config.timeoutMs,
    createTransport: () => cell.browser === "chrome" || cell.browser === "firefox" ? createPlaywrightTransport(cell.browser, config.timeoutMs) : nativeTransport(cell, config),
    saveLog: async text => { await writeFile(join(config.output, "logs", boxId(cell).replaceAll("/", "-") + ".log"), text); },
  }, cell.attempts);
}
export async function run(config: Options): Promise<Report> {
  const report = await initialReport(config);
  await mkdir(join(config.output, "logs"), { recursive: true });
  await saveReport(config.output, report);
  const server = Bun.spawn(["bun", "web/serve.ts"], { env: { ...process.env, ROOT: config.root, HOST: "127.0.0.1", PORT: "0" }, stdout: "pipe", stderr: "inherit" });
  let base = "";
  try {
    const reader = server.stdout.getReader();
    const first = await reader.read(); reader.releaseLock();
    base = /at (http:\/\/\S+)/.exec(new TextDecoder().decode(first.value))?.[1] ?? "";
    if (!base) throw new Error("Playground asset server did not publish a URL");
    for (const [index, cell] of report.cells.entries()) {
      if (!selectedCell(cell, config)) continue;
      report.cells[index] = await runCell(cell, config, base);
      await saveReport(config.output, report);
      console.log(boxId(cell), report.cells[index]?.status);
    }
  } finally { server.kill("SIGTERM"); await server.exited; }
  return report;
}
if (import.meta.main) {
  const report = await run(options(process.argv.slice(2)));
  process.exitCode = report.cells.some(cell => cell.status === "fail") ? 1 : 0;
}
