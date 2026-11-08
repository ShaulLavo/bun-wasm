import { cp, mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, options, unavailableReport, type Options } from "./run";
import { sameDeadlines } from "./deadlines";
import { saveReport } from "./report";
import { validateReport, type Report } from "./model";
import { bounded } from "./execute";
import { ownedCommand, withSignals } from "./lifetime";
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
class NativeUnavailable extends Error {}
async function discoverMac(signal: AbortSignal): Promise<string> {
  try {
    const home = (await ownedCommand(["mesh", "ssh", "mac", "--", "sh", "-lc", "printf '%s' \"$HOME\""], signal)).trim();
    if (!home.startsWith("/Users/") || /[\r\n]/.test(home)) throw new Error("Unexpected Mac home from discovery");
    await ownedCommand(["mesh", "ssh", "mac", "--", "zsh", "-lc", "python3 ~/.agents/skills/machine-fleet/scripts/availability.py check"], signal, 15_000);
    return home;
  } catch (error) { signal.throwIfAborted(); throw new NativeUnavailable(String(error)); }
}
export function combine(first: Report, second: Report): Report {
  validateReport(first); validateReport(second);
  if (JSON.stringify(first.source) !== JSON.stringify(second.source)) throw new Error("Shard sources and assets differ");
  if (!sameDeadlines(first.deadlines, second.deadlines)) throw new Error("Shard deadline policies differ");
  const cells = first.cells.map((cell, index) => {
    const other = second.cells[index];
    if (!other || other.framework !== cell.framework || other.browser !== cell.browser || other.engine !== cell.engine) throw new Error("Shard ordering differs");
    if (other.status === "pending") return cell;
    if (cell.attempts.length && other.attempts.length) {
      const firstPrefix = JSON.stringify(cell.attempts) === JSON.stringify(other.attempts.slice(0, cell.attempts.length));
      const secondPrefix = JSON.stringify(other.attempts) === JSON.stringify(cell.attempts.slice(0, other.attempts.length));
      if (firstPrefix) return other;
      if (secondPrefix) return cell;
      throw new Error("Overlapping attempted shard boxes");
    }
    return other.attempts.length || cell.status === "pending" ? other : cell;
  });
  return { ...first, cells, resources: (first.resources ?? []).concat(second.resources ?? []) };
}
async function bundle(destination: string, source: Report["source"]): Promise<void> {
  await mkdir(join(destination, "web"), { recursive: true });
  const runner = await Bun.build({ entrypoints: [resolve(import.meta.dir, "run.ts")], outdir: destination, target: "bun", format: "esm", naming: "run.js", external: ["playwright"] });
  const server = await Bun.build({ entrypoints: [resolve("web/serve.ts")], outdir: join(destination, "web"), target: "bun", format: "esm", naming: "serve.ts" });
  if (!runner.success || !server.success) throw new AggregateError(runner.logs.concat(server.logs), "Fleet runner bundle failed");
  await writeFile(join(destination, "source.json"), JSON.stringify(source));
  await writeFile(join(destination, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { playwright: "1.64.1" } }));
}
async function verifyRemoteStopped(remote: string): Promise<void> {
  const script = `set -eu; cd ${quote(remote)}; pid=$(cat runner.pid); if kill -0 "$pid" 2>/dev/null; then exit 75; fi; cat report/native-cleanup.json`;
  const cleanup: unknown = JSON.parse(await ownedCommand(["mesh", "ssh", "mac", "--", "sh", "-lc", script], undefined, 20_000));
  if (!cleanup || typeof cleanup !== "object" || !("driverExited" in cleanup) || cleanup.driverExited !== true || !("lockRemoved" in cleanup) || cleanup.lockRemoved !== true) throw new Error("Remote driver/lock shutdown is unproved; retaining staging");
}
export async function removeStaging(remote: string, started: boolean, config: Options): Promise<void> {
  if (started) await verifyRemoteStopped(remote);
  await ownedCommand(["mesh", "ssh", "mac", "--", "rm", "-rf", remote]);
  await ownedCommand(["mesh", "ssh", "mac", "--", "test", "!", "-e", remote]);
  await writeFile(join(config.output, "fleet-cleanup.json"), JSON.stringify({ remote, stagingRemoved: true, consumersStopped: true, at: new Date().toISOString() }, null, 2));
}
export function nativeRunnerArgs(config: Options, remote: string): string[] {
  const installs = Object.entries(config.installTimeouts).map(([framework, timeout]) => `${framework}:${timeout}`).join(",");
  return [`--root=${remote}/dist`, `--output=${remote}/report`, `--browsers=${config.browsers.join(",")}`, `--engines=${config.engines.join(",")}`, `--frameworks=${config.frameworks.join(",")}`, `--timeout-ms=${config.timeoutMs}`, `--asset-source=${config.assetSource}`, `--source-file=${remote}/source.json`].concat(installs ? [`--install-timeout-ms=${installs}`] : [], config.deviceUDID ? [`--device-udid=${config.deviceUDID}`] : [], config.resume ? ["--resume"] : [], config.retryFailures ? ["--retry-failures"] : []);
}
async function mac(config: Options, source: Report["source"], local: string, signal: AbortSignal): Promise<Report> {
  const home = await discoverMac(signal);
  const call = (args: string[]) => ownedCommand(args, signal);
  const remote = `${home}/tmp/bun-wasm-goals-${crypto.randomUUID()}`;
  let started = false;
  let failure: unknown;
  try {
    await call(["mesh", "ssh", "mac", "--", "mkdir", remote]);
    await bundle(local, source);
    await cp(config.root, join(local, "dist"), { recursive: true });
    if (config.resume) {
      await mkdir(join(local, "report"), { recursive: true });
      await cp(join(config.output, "TABLE.json"), join(local, "report/TABLE.json"));
    }
    for (const name of await readdir(local)) await call(["mesh", "cp", "-r", join(local, name), `mac:${remote}/${name}`]);
    const args = nativeRunnerArgs(config, remote);
    const script = `set -eu; cd ${quote(remote)}; export PATH="$HOME/.bun/bin:$PATH"; bun install --ignore-scripts; echo $$ > runner.pid; exec bun run.js ${args.map(quote).join(" ")}`;
    signal.throwIfAborted(); started = true;
    await ownedCommand(["mesh", "ssh", "mac", "--", "zsh", "-lc", script], signal, 86_400_000, true, [0, 1]);
    await call(["mesh", "cp", "-r", `mac:${remote}/report`, local + "/collected"]);
    return await collectNativeReport(join(local, "collected"), config.output);
  } catch (error) { failure = error; throw error; }
  finally { await cleanupStaging(remote, started, config, failure); }
}
export async function collectNativeReport(collected: string, output: string): Promise<Report> {
  const report: unknown = JSON.parse(await readFile(join(collected, "TABLE.json"), "utf8"));
  validateReport(report);
  await cp(join(collected, "logs"), join(output, "logs"), { recursive: true });
  await cp(join(collected, "native-cleanup.json"), join(output, "native-cleanup.json"));
  return report;
}
async function cleanupStaging(remote: string, started: boolean, config: Options, failure: unknown): Promise<void> {
  try { await removeStaging(remote, started, config); }
  catch (error) {
    await writeFile(join(config.output, "fleet-cleanup.json"), JSON.stringify({ remote, stagingRemoved: false, error: String(error), removalCondition: "Verify runner, driver and owned lock have stopped before removing this staging directory" }, null, 2));
    if (failure !== undefined) throw new AggregateError([failure, error], `${String(failure)}; cleanup: ${String(error)}`);
    throw error;
  }
}
async function runFleet(config: Options, signal: AbortSignal): Promise<Report> {
  const localBrowsers = config.browsers.filter(browser => browser === "chrome" || browser === "firefox");
  const nativeBrowsers = config.browsers.filter(browser => browser === "safari" || browser === "iphone-safari");
  const local = await run({ ...config, signal, browsers: localBrowsers });
  signal.throwIfAborted();
  if (!nativeBrowsers.length) return local;
  const nativeConfig = { ...config, browsers: nativeBrowsers };
  if (nativeBrowsers.includes("iphone-safari") && !config.deviceUDID) {
    const unavailable = await unavailableReport({ ...nativeConfig, browsers: ["iphone-safari"] }, "No claimed iPhone simulator; use T3 device_open and pass --device-udid", local);
    local.cells = combine(local, unavailable).cells;
    nativeConfig.browsers = nativeBrowsers.filter(browser => browser !== "iphone-safari");
    if (!nativeConfig.browsers.length) return local;
  }
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-goals-fleet-"));
  try {
    const native = await mac(nativeConfig, local.source, scratch, signal);
    return combine(local, native);
  } catch (error) {
    if (!(error instanceof NativeUnavailable)) throw error;
    return unavailableReport(nativeConfig, error, local);
  } finally { await bounded(() => rm(scratch, { recursive: true, force: true }), 30_000); }
}
export async function fleet(config: Options): Promise<Report> { return withSignals(signal => lockedFleet(config, signal), config.signal); }
async function lockedFleet(config: Options, signal: AbortSignal): Promise<Report> {
  await mkdir(config.output, { recursive: true });
  const lock = join(config.output, ".goals-fleet-lock");
  await mkdir(lock);
  try {
    signal.throwIfAborted();
    const report = await runFleet(config, signal);
    report.command = "source env.sh && bun scripts/goals-matrix/fleet.ts " + process.argv.slice(2).map(quote).join(" ");
    await saveReport(config.output, report);
    return report;
  } finally { await rmdir(lock); }
}
if (import.meta.main) {
  const report = await fleet(options(process.argv.slice(2)));
  process.exitCode = report.cells.some(cell => cell.status === "fail") ? 1 : 0;
}
