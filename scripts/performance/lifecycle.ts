import { mkdir, readFile, writeFile, stat, rename, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus, hostname, loadavg, release } from "node:os";
import { baseMatrix, validateLifecycle, type LifecycleCell } from "./lifecycle-model";
import { nativeLifecycle, diagnosticNativeLifecycle } from "./lifecycle-native";
import { browserLifecycle, diagnosticBrowserLifecycle } from "./lifecycle-browser";
import { launchProcess, processIdentity, cpuTopology } from "./lifecycle-process";
import { withSignals } from "../goals-matrix/lifetime";
import { until } from "../goals-matrix/playground";
import { summarizeLifecycle } from "./lifecycle-summary";
import { assetIdentity } from "../goals-matrix/assets";
import { preflight } from "../goals-matrix/preparation";
import { canonical, object, sha256, treeInventory } from "./input";
import { executionIdentity, finalizeHostVerification, lifecycleDriverInputs, recordInvocationEnvironment, verifyResume } from "./lifecycle-campaign";

function options(args: string[]): { output: string; scratch: string; host: string; prepared: string; cells: string[]; timeoutMs: number; mode: "timing" | "selection" | "controls" | "observation" | "observer-off" } {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(output|scratch|host|prepared|cells|timeout-ms|mode)=(.+)$/.exec(arg);
    if (!match?.[1] || !match[2] || values.has(match[1])) throw new Error(`Invalid lifecycle option ${arg}`);
    values.set(match[1], match[2]);
  }
  const required = (name: string) => { const value = values.get(name); if (!value) throw new Error(`Missing --${name}`); return resolve(value); };
  const timeoutMs = Number(values.get("timeout-ms") ?? 300000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("Invalid timeout");
  const cells = values.get("cells")?.split(",") ?? baseMatrix().map(cell => cell.id);
  if (cells.some(id => !baseMatrix().some(cell => cell.id === id))) throw new Error("Unknown matrix cell");
  const mode = values.get("mode") ?? "timing";
  if (mode !== "timing" && mode !== "selection" && mode !== "controls" && mode !== "observation" && mode !== "observer-off") throw new Error("Use timing, selection, controls, observation or observer-off");
  if (mode === "controls" && cells.some(id => baseMatrix().find(cell => cell.id === id)?.arm.kind !== "goals-browser")) throw new Error("Startup controls mode supports browser cells only");
  if (mode === "selection" && cells.some(id => baseMatrix().find(cell => cell.id === id)?.arm.kind !== "native")) throw new Error("Selection probes currently support native cells only");
  return { output: required("output"), scratch: required("scratch"), host: required("host"), prepared: required("prepared"), cells, timeoutMs, mode };
}
type Config = ReturnType<typeof options>;
async function save(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
async function runCell(cell: LifecycleCell, config: Config, base: string, signal: AbortSignal, invocation: string) {
  const output = join(config.output, cell.id);
  if (await stat(join(output, "run.json")).then(() => true).catch(() => false)) return null;
  if (await stat(output).then(() => true).catch(() => false)) await rename(output, output + `.interrupted-${Date.now()}`);
  await mkdir(output);
  const before = { at: new Date().toISOString(), load: loadavg(), controller: await processIdentity(process.pid) };
  let result: Awaited<ReturnType<typeof executeCell>> | undefined;
  let failure: string | null = null;
  try {
    result = await executeCell(cell, config, base, output, signal);
    if (result.outcome) validateLifecycle(result.outcome);
  } catch (error) { failure = String(error); }
  const cleanup = await readFile(join(output, "cleanup.json"), "utf8").then(text => JSON.parse(text)).catch(() => ({ resourcesStopped: null, reason: "No separate cleanup record; see terminal and controller failure" }));
  const execution = await readFile(join(output, "execution.json"), "utf8").then(text => JSON.parse(text)).catch(() => ({ status: "unavailable", reason: "Adapter execution evidence could not be read" }));
  await save(join(output, "run.json"), { schema: 1, id: cell.id, cell, before, after: { at: new Date().toISOString(), load: loadavg() },
    workloadOutcome: failure ? { status: "fail", reason: failure } : { status: "pass" }, result: result ?? null, cleanup, execution, invocation,
    timing: { valid: null, eligible: failure === null && result?.inputs.valid === true && config.mode === "timing", hostVerification: join(invocation, "host-verification.json"), verificationReason: "Host verification pending", unit: "ms", scope: cell.arm.kind === "native" && cell.workload === "vite" ? "Native server plus matching preview browser lifecycle" : "Framework lifecycle command", sourceRun: cell.id,
      method: cell.arm.kind === "native" && cell.workload === "next" ? "Monotonic command submission to process-close event observation" : "Monotonic command submission to successful polling observation", value: result?.wallMs ?? null },
    observation: { kind: config.mode, cpu: null, counters: null, profile: null, reason: config.mode === "observation" || config.mode === "controls" ? "See separate observation/control files; incomplete polling, excluded from timing distributions" : "No external CPU/profile observer in the measured job", compilerSelection: config.mode === "selection" ? "See selection.jsonl, scoped preloaded contexts only" : "Unavailable in uninstrumented timing; collect a separate selection run" },
    contention: { quiet: false, overlappingJobs: "See runner job receipt" }, headlineEligible: false,
    ineligibleReasons: ["Nonquiet shared PC experiment", ...(cell.arm.kind === "goals-browser" || cell.arm.browser ? ["Headless browser; display and hardware renderer unverified"] : [])] });
  console.log(cell.id, failure ? `fail; see ${output}/run.json` : "pass");
  await summarizeLifecycle(config.output);
  return join(output, "run.json");
}
async function executeCell(cell: LifecycleCell, config: Config, base: string, output: string, signal: AbortSignal) {
  if (cell.arm.kind === "native") {
    if (config.mode === "observation" || config.mode === "observer-off") return diagnosticNativeLifecycle(cell, config.prepared, config.scratch, output, config.timeoutMs, signal, config.mode);
    return nativeLifecycle(cell, config.prepared, config.scratch, output, config.timeoutMs, signal, config.mode === "selection" ? "selection" : "timing");
  }
  if (config.mode === "controls" || config.mode === "observation" || config.mode === "observer-off") {
    const metadata = object(JSON.parse(await readFile(join(config.host, "lifecycle-host.json"), "utf8")));
    return diagnosticBrowserLifecycle(cell, base, config.prepared, output, config.timeoutMs, signal, { mode: config.mode, sharing: metadata.sharing === "unshared" ? "unshared" : "shared" });
  }
  return browserLifecycle(cell, base, config.prepared, output, config.timeoutMs, signal);
}

async function campaign(config: Config, signal: AbortSignal) {
  await mkdir(config.output, { recursive: true });
  const lock = join(config.output, ".lifecycle-lock");
  await mkdir(lock);
  try { await campaignLocked(config, signal); }
  finally { await rmdir(lock); }
}
async function campaignLocked(config: Config, signal: AbortSignal) {
  const host = object(JSON.parse(await readFile(join(config.host, "lifecycle-host.json"), "utf8")));
  if (host.waffle !== "0.0.129") throw new Error("Prepared host must assert Waffle 0.0.129");
  await preflight(config.host, ["browser", "quickjs", "jsc", "spidermonkey"]);
  const inputs = { mode: config.mode, timeoutMs: config.timeoutMs, host: await assetIdentity(config.host),
    drivers: lifecycleDriverInputs(process.cwd()), execution: await executionIdentity(), templates: { next: treeInventory("sandbox/template-next"), vite: treeInventory("sandbox/template") },
    installedInventories: await Promise.all(["next", "vite"].map(async name => ({ workload: name, inventory: sha256(await readFile(join(config.prepared, `${name}-inventory.json`))), lock: sha256(await readFile(join(config.prepared, name, "bun.lock"))) }))) };
  const inputPath = join(config.output, "inputs.json");
  const previous = await readFile(inputPath, "utf8").catch(() => null);
  if (previous !== null) verifyResume(JSON.parse(previous), inputs);
  if (previous === null) await save(inputPath, inputs);
  await save(join(config.output, "run-list.json"), baseMatrix());
  const invocation = await recordInvocationEnvironment(config.output, { hostname: hostname(), kernel: release(), cpus: cpus(),
    topology: await cpuTopology(), browserEnvironment: Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "PLAYWRIGHT_BROWSERS_PATH", "GOALS_CHROME_EXECUTABLE"].map(key => [key, process.env[key] ?? null])),
    controller: await processIdentity(process.pid), host: JSON.parse(await readFile(join(config.host, "lifecycle-host.json"), "utf8")),
    cache: { install: "outside timing, frozen resolution", application: "reset immediately before submission", OSPageCache: "uncontrolled", wasmCompilation: "page ready before timing", nodeCompileCache: "disabled" } });
  const needsServer = config.cells.some(id => baseMatrix().find(cell => cell.id === id)?.arm.kind === "goals-browser");
  const serverOutput = join(config.output, `asset-server-${Date.now()}`);
  if (needsServer) await mkdir(serverOutput);
  const server = needsServer ? launchProcess([process.execPath, "web/serve.ts"], process.cwd(), { ...process.env, ROOT: config.host, HOST: "127.0.0.1", PORT: "0", PREVIEW_ORIGINS: "1" }, serverOutput) : null;
  const records: string[] = [];
  try {
    const base = server ? await until(async () => /at (http:\/\/\S+)/.exec(await readFile(join(serverOutput, "stdout.txt"), "utf8").catch(() => ""))?.[1] ?? "", Boolean, 10000) : "";
    for (const id of config.cells) {
      signal.throwIfAborted();
      const cell = baseMatrix().find(cell => cell.id === id);
      const record = cell ? await runCell(cell, config, base, signal, invocation) : null;
      if (record) records.push(record);
    }
  } finally {
    try { await server?.close(); }
    finally { await verifyHost(config, inputs.host, invocation, records); }
  }
}
async function verifyHost(config: Config, expected: unknown, invocation: string, records: string[]): Promise<void> {
  let valid = false;
  let reason = "Prepared host changed during invocation";
  try { valid = canonical(await assetIdentity(config.host)) === canonical(expected); }
  catch (error) { reason = `Host verification unavailable: ${String(error)}`; }
  if (valid) reason = "Prepared host unchanged during invocation";
  await finalizeHostVerification(config.output, records, join(invocation, "host-verification.json"), valid, reason);
  await summarizeLifecycle(config.output);
  if (!valid) throw new Error(reason);
}
if (import.meta.main) await withSignals(signal => campaign(options(process.argv.slice(2)), signal));
