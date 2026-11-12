import { cp, mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, options, unavailableReport, type Options } from "./run";
import { sameDeadlines } from "./deadlines";
import { saveReport } from "./report";
import { validateReport, type Report } from "./model";
import { bounded } from "./execute";
import { buildAngularDiagnosticSource } from "./angular-diagnostic";
import { CommandExitError, ownedCommand, withSignals } from "./lifetime";
import { quote, admission, nativeQueueScript } from "./mac-queue";
class NativeUnavailable extends Error {}
async function discoverMac(signal: AbortSignal): Promise<string> {
  try {
    const home = (await ownedCommand(["mesh", "ssh", "mac", "--", "sh", "-lc", "printf '%s' \"$HOME\""], signal)).trim();
    if (!home.startsWith("/Users/") || /[\r\n]/.test(home)) throw new Error("Unexpected Mac home from discovery");
    await ownedCommand(["mesh", "ssh", "mac", "--", "zsh", "-lc", "python3 ~/.agents/skills/machine-fleet/scripts/availability.py check --owner-only"], signal, 15_000);
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
  const diagnostic = await buildAngularDiagnosticSource();
  const runner = await Bun.build({ entrypoints: [resolve(import.meta.dir, "run.ts")], outdir: destination, target: "bun", format: "esm", naming: "run.js", external: ["playwright"], define: { __GOALS_ANGULAR_DIAGNOSTIC__: JSON.stringify(diagnostic) } });
  const server = await Bun.build({ entrypoints: [resolve("web/serve.ts")], outdir: join(destination, "web"), target: "bun", format: "esm", naming: "serve.ts" });
  if (!runner.success || !server.success) throw new AggregateError(runner.logs.concat(server.logs), "Fleet runner bundle failed");
  await writeFile(join(destination, "source.json"), JSON.stringify(source));
  await writeFile(join(destination, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { playwright: "1.64.1" } }));
}
async function verifyRemoteStopped(remote: string, waitForQueueExit: boolean): Promise<void> {
  const acknowledgement = waitForQueueExit ? "while [ ! -s queue-exit ]; do sleep 0.1; done; " : "";
  const script = `set -eu; cd ${quote(remote)}; ${acknowledgement}code=$(cat queue-exit); case "$code" in ''|*[!0-9]*) exit 75;; esac; "$HOME/.bun/bin/bun" "$HOME/.agents/skills/machine-fleet/scripts/mac-queue.ts" status`;
  const status: unknown = JSON.parse(await ownedCommand(["mesh", "ssh", "mac", "--", "sh", "-lc", script], undefined, 20_000));
  if (!status || typeof status !== "object" || !("holder" in status) || !("waiting" in status) || !Array.isArray(status.waiting)) throw new Error("Remote queue shutdown is unproved; retaining staging");
  const tickets: unknown[] = (status.holder === null ? [] : [status.holder]).concat(status.waiting);
  for (const ticket of tickets) {
    if (!ticket || typeof ticket !== "object" || !("task" in ticket) || typeof ticket.task !== "string" || ticket.task === `bun-wasm goals ${remote}`) throw new Error("Remote queue shutdown is unproved; retaining staging");
  }
  await verifyNativeStopped(remote);
}
async function verifyNativeStopped(remote: string): Promise<void> {
  const script = `set -eu; cd ${quote(remote)}; started=false; if [ -e queue-workload-started ]; then started=true; fi; cleanup=null; if [ -e report/native-cleanup.json ]; then cleanup=$(cat report/native-cleanup.json); fi; printf '{"workloadStarted":%s,"cleanup":%s}\n' "$started" "$cleanup"`;
  const proof: unknown = JSON.parse(await ownedCommand(["mesh", "ssh", "mac", "--", "sh", "-lc", script], undefined, 20_000));
  if (!proof || typeof proof !== "object" || !("workloadStarted" in proof) || typeof proof.workloadStarted !== "boolean" || !("cleanup" in proof)) throw new Error("Remote native shutdown is unproved; retaining staging");
  if (proof.cleanup === null && !proof.workloadStarted) return;
  const cleanup = proof.cleanup;
  if (!cleanup || typeof cleanup !== "object" || !("driverExited" in cleanup) || cleanup.driverExited !== true
    || !("safariExited" in cleanup) || cleanup.safariExited !== true || !("admissionOwner" in cleanup) || cleanup.admissionOwner !== "installed-mac-queue") throw new Error("Remote native shutdown is unproved; retaining staging");
}
export async function removeStaging(remote: string, started: boolean, config: Options, waitForQueueExit = false): Promise<void> {
  if (started) await verifyRemoteStopped(remote, waitForQueueExit);
  await ownedCommand(["mesh", "ssh", "mac", "--", "rm", "-rf", remote]);
  await ownedCommand(["mesh", "ssh", "mac", "--", "test", "!", "-e", remote]);
  await writeFile(join(config.output, "fleet-cleanup.json"), JSON.stringify({ remote, stagingRemoved: true, consumersStopped: true, at: new Date().toISOString() }, null, 2));
}
export function nativeRunnerArgs(config: Options, remote: string): string[] {
  const installs = Object.entries(config.installTimeouts).map(([framework, timeout]) => `${framework}:${timeout}`).join(",");
  const queue = admission(config);
  return [`--profile=${config.profile ?? "split"}`, `--mac-lane=${queue.lane}`, `--mac-thread=${queue.thread}`, `--mac-expected-seconds=${queue.expectedSeconds}`, `--mac-wait-seconds=${queue.waitSeconds}`, `--mac-timeout-seconds=${queue.timeoutSeconds}`, `--root=${remote}/dist`, `--output=${remote}/report`, `--browsers=${config.browsers.join(",")}`, `--engines=${config.engines.join(",")}`, `--frameworks=${config.frameworks.join(",")}`, `--asset-source=${config.assetSource}`, `--source-file=${remote}/source.json`].concat(config.timeoutMs === undefined ? [] : [`--timeout-ms=${config.timeoutMs}`], installs ? [`--install-timeout-ms=${installs}`] : [], config.deviceUDID ? [`--device-udid=${config.deviceUDID}`] : [], config.resume ? ["--resume"] : [], config.retryFailures ? ["--retry-failures"] : [], config.safariOwnership ? ["--safari-ownership"] : []);
}
async function mac(config: Options, source: Report["source"], local: string, signal: AbortSignal): Promise<Report> {
  admission(config);
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
    const script = nativeQueueScript(config, remote, home, args);
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
  try { await cp(join(collected, "logs"), join(output, "logs"), { recursive: true }); }
  catch (error) {
    const noAttempts = report.cells.every(cell => cell.attempts.length === 0);
    if (!(noAttempts && error instanceof Error && "code" in error && error.code === "ENOENT" && "path" in error && error.path === join(collected, "logs"))) throw error;
  }
  await cp(join(collected, "native-cleanup.json"), join(output, "native-cleanup.json"));
  return report;
}
async function collectFailedOwnership(remote: string, output: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-ownership-"));
  try {
    await ownedCommand(["mesh", "cp", "-r", `mac:${remote}/report/logs`, join(scratch, "logs")], undefined, 30_000);
    await cp(join(scratch, "logs"), join(output, "logs"), { recursive: true });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
export async function cleanupStaging(remote: string, started: boolean, config: Options, failure: unknown): Promise<void> {
  try {
    if (started && failure !== undefined && config.safariOwnership) await collectFailedOwnership(remote, config.output);
    await removeStaging(remote, started, config, failure !== undefined);
  }
  catch (error) {
    await writeFile(join(config.output, "fleet-cleanup.json"), JSON.stringify({ remote, stagingRemoved: false, error: String(error), removalCondition: "Verify the installed queue has settled and its supervised consumers have stopped before removing this staging directory" }, null, 2));
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
  try {
    const report = await fleet(options(process.argv.slice(2)));
    process.exitCode = report.cells.some(cell => cell.status === "fail") ? 1 : 0;
  } catch (error) {
    if (!(error instanceof CommandExitError)) throw error;
    console.error(error.message); process.exitCode = error.code;
  }
}
