import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadavg } from "node:os";
import { gzipSync } from "node:zlib";
import { object, sha256 } from "./input";
import { profileTransport, type ProfileBrowser } from "./lifecycle-profile-transport";
import { computationControl } from "./lifecycle-profile-control";
import { analyzeChrome, analyzeGecko, chromeControl, geckoControl } from "./lifecycle-profile-analysis";
import { launchProcess, processTree } from "./lifecycle-process";
import { ready, command, terminal, until, start, openPreview, render, checkClick, stopServer } from "../goals-matrix/playground";
import { frameworks } from "../goals-matrix/catalog";
import { playgroundURL } from "../goals-matrix/run";
import { withSignals } from "../goals-matrix/lifetime";
import { bounded } from "../goals-matrix/bounded";
import { isEngine } from "../../web/src/engine-loader";
import { mutableRoots, nextOutputs } from "./lifecycle-model";
import { assetIdentity } from "../goals-matrix/assets";
import { preflight } from "../goals-matrix/preparation";
import { verifyResolution } from "./lifecycle-lock";

async function json(path: string) { return JSON.parse(await readFile(path, "utf8")); }
async function save(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
function options(args: string[]) {
  const [host, prepared, output, browser, engine, phase, control] = args;
  if (!host || !prepared || !output || !engine || !isEngine(engine) || (browser !== "chrome" && browser !== "firefox") ||
    (phase !== "control" && phase !== "next" && phase !== "vite" && phase !== "next-off" && phase !== "vite-off")) {
    throw new Error("Usage: lifecycle-profile.ts HOST PREPARED NEW_OUTPUT chrome|firefox ENGINE control|next|vite|next-off|vite-off [PASSED_CONTROL/run.json]");
  }
  if (phase !== "control" && !control) throw new Error("Actual jobs require a passed exact-context control");
  const selection: { browser: ProfileBrowser } = { browser };
  return { host: resolve(host), prepared: resolve(prepared), output: resolve(output), ...selection, engine, phase, control: control ? resolve(control) : null };
}
type Config = ReturnType<typeof options>;

async function capture(config: Config, base: string, signal: AbortSignal, hostIdentity: unknown) {
  const enabled = !config.phase.endsWith("-off");
  const session = await profileTransport(config.browser, config.output, enabled, 300000);
  const transport = session.transport;
  const interrupt = () => { void transport.close().catch(() => {}); };
  signal.addEventListener("abort", interrupt, { once: true });
  const window = { before: 0, after: 0 };
  let failure: string | null = null;
  let observerFailure: string | null = null;
  let stop: (() => Promise<void>) | undefined;
  const evidence: Record<string, unknown> = {};
  try {
    const workload = config.phase.startsWith("vite") ? "vite" : "next";
    const framework = frameworks.find(row => row.id === (workload === "next" ? "next" : "vite-react"))!;
    await transport.navigate(playgroundURL(base, framework, config.engine, "split"));
    evidence.runtime = await ready(transport, config.engine, 300000, "split");
    evidence.processes = await processTree(process.pid);
    if (config.phase !== "control") evidence.preparation = await install(config, transport, workload);
    else await transport.evaluate(`playground.fs.writeFile('/home/user/lifecycle-profile-control.ts', ${JSON.stringify(computationControl)})`);
    stop = await session.capture();
    window.before = Date.now();
    evidence.loadBefore = loadavg();
    evidence.outcome = await bounded(() => runJob(config, transport, framework), 300000, signal);
    window.after = Date.now();
    evidence.loadAfter = loadavg();
    if (config.phase === "control" && !String(object(evidence.outcome).output).includes("PROFILE_CONTROL_DONE")) throw new Error("Control marker missing");
  } catch (error) { failure = String(error); }
  finally {
    if (!window.after) window.after = Date.now();
    await save(join(config.output, "window.json"), window);
    try { await stop?.(); }
    catch (error) { observerFailure = String(error); }
    await writeFile(join(config.output, "terminal.txt"), await bounded(() => terminal(transport), 3000).catch(String));
    await bounded(() => stopServer(transport, 3000), 4000).catch(() => {});
    let browserClosed = false;
    try { await transport.close(); browserClosed = true; }
    catch (error) { observerFailure = `${observerFailure ?? ""} Browser cleanup: ${String(error)}`; }
    signal.removeEventListener("abort", interrupt);
    await save(join(config.output, "workers.json"), session.workers);
    await save(join(config.output, "cleanup.json"), { browserClosed, workersClosed: browserClosed ? true : null,
      reason: browserClosed ? "Browser close resolved" : "Browser close failed; the enclosing runner must reap descendants and verify cleanup" });
  }
  const profile = observerFailure ? { available: false, reason: observerFailure } : await analysis(config, window, enabled).catch(error => ({ available: false, reason: String(error) }));
  await save(join(config.output, "run.json"), { schema: 1, configuration: { browser: config.browser, engine: config.engine, phase: config.phase, profile: "split" },
    hostIdentity, browser: transport.capabilities, window, observedWallMs: window.before ? window.after - window.before : null, evidence, workloadFailure: failure, observerFailure,
    observation: { enabled, profile }, control: config.control, headlineEligible: false, timingDistribution: "separate diagnostic only",
    limits: ["Headless nonquiet shared PC", "Profile shares do not decompose wall time or prove causal speedup", "Observer-on/off variation is not wholly profiler inflation", "No multiplication of one worker share by whole-job CPU"] });
}
type SessionTransport = Awaited<ReturnType<typeof profileTransport>>["transport"];
async function install(config: Config, transport: SessionTransport, workload: "next" | "vite") {
  const lock = await readFile(join(config.prepared, workload, "bun.lock"), "utf8");
  await transport.evaluate(`playground.fs.writeFile('/home/user/bun.lock', ${JSON.stringify(lock)})`);
  await command(transport, "bun install", 300000);
  const resolved = await transport.evaluate<string>("(async () => new TextDecoder().decode(await playground.fs.readFile('/home/user/bun.lock')))()");
  const resolution = verifyResolution(lock, resolved);
  await command(transport, "bun install --frozen-lockfile", 300000);
  await transport.evaluate(`(async () => { for (const path of ${JSON.stringify(mutableRoots[workload])}) await playground.fs.remove('/home/user/' + path); })()`);
  const absent = await transport.evaluate<boolean>(`(async () => (await Promise.all(${JSON.stringify(mutableRoots[workload])}.map(path => playground.fs.lookup('/home/user/' + path)))).every(value => !value))()`);
  if (!absent) throw new Error("Application cache reset failed");
  return { resolution, applicationCacheAbsent: absent, nativeLockSha256: sha256(lock), guestLockSha256: sha256(resolved), installOutsideWindow: true };
}
async function runJob(config: Config, transport: SessionTransport, framework: (typeof frameworks)[number]) {
  if (config.phase === "control") return command(transport, "bun lifecycle-profile-control.ts", 60000);
  if (config.phase.startsWith("next")) {
    const result = await command(transport, "NEXT_TELEMETRY_DISABLED=1 bun run build", 300000);
    const outputs = await transport.evaluate<{ path: string; bytes: number | null }[]>(`Promise.all(${JSON.stringify(nextOutputs)}.map(async path => ({ path, bytes: (await playground.fs.readFile('/home/user/' + path))?.byteLength ?? null })))`);
    if (outputs.some(row => row.bytes === null || row.bytes <= 0)) throw new Error("Missing Next output");
    return { result, outputs };
  }
  await start(transport, "bun run dev", 300000);
  await openPreview(transport, 300000);
  await render(transport, framework, framework.text, 300000);
  const counter = await checkClick(transport, framework, 300000);
  return { counter };
}
async function analysis(config: Config, window: { before: number; after: number }, enabled: boolean) {
  if (!enabled) return { available: null, reason: "Observer-off workload control" };
  const path = join(config.output, config.browser === "chrome" ? "chrome-trace.json" : "gecko.json");
  const bytes = await readFile(path);
  await writeFile(path + ".gz", gzipSync(bytes));
  const input = JSON.parse(bytes.toString());
  const rows = config.browser === "chrome" ? analyzeChrome(input, config.engine, config.phase) : analyzeGecko(input, window);
  await save(join(config.output, "analysis.json"), rows);
  if (!rows.some(row => "analysis" in row ? row.analysis.samples > 0 : row.samples > 0)) throw new Error("No scoped samples retained");
  if (config.phase !== "control") return { available: true, analysis: "analysis.json", raw: path + ".gz", sourceSha256: sha256(bytes) };
  const control = config.browser === "chrome" ? chromeControl(input, await json(join(config.output, "chrome-targets.json")), config.engine, window) : geckoControl(input, window, config.engine);
  return { ...control, sourceSha256: sha256(bytes), analysis: "analysis.json", raw: path + ".gz" };
}
async function campaign(config: Config, signal: AbortSignal) {
  await mkdir(config.output);
  const host = object(await json(join(config.host, "lifecycle-host.json")));
  if (host.waffle !== "0.0.122") throw new Error("Waffle 0.0.122 required");
  await preflight(config.host, [config.engine]);
  const hostIdentity = sha256(JSON.stringify(await assetIdentity(config.host)));
  if (config.control) await requireControl(config, hostIdentity);
  await save(join(config.output, "sources.json"), { host, hostIdentity });
  const server = launchProcess([process.execPath, "web/serve.ts"], process.cwd(), { ...process.env, ROOT: config.host, HOST: "127.0.0.1", PORT: "0", PREVIEW_ORIGINS: "1" }, config.output);
  try {
    const base = await until(async () => /at (http:\/\/\S+)/.exec(await readFile(join(config.output, "stdout.txt"), "utf8").catch(() => ""))?.[1] ?? "", Boolean, 10000);
    await capture(config, base, signal, hostIdentity);
  } catch (error) {
    const saved = await stat(join(config.output, "run.json")).then(() => true).catch(() => false);
    if (!saved) await save(join(config.output, "run.json"), { configuration: { browser: config.browser, engine: config.engine, phase: config.phase }, hostIdentity,
      workloadFailure: String(error), observation: { profile: { available: false, reason: "Capture setup/cleanup failed; see failure and separate cleanup records" } }, headlineEligible: false });
  } finally { await server.close(); await save(join(config.output, "server-cleanup.json"), { stopped: true }); }
}
async function requireControl(config: Config, hostIdentity: string) {
  const control = object(await json(config.control!));
  const configuration = object(control.configuration);
  const profile = object(object(control.observation).profile);
  if (configuration.browser !== config.browser || configuration.engine !== config.engine || configuration.phase !== "control" ||
    control.hostIdentity !== hostIdentity || profile.available !== true || control.workloadFailure !== null) throw new Error("Exact-context profiler control unavailable; actual capture is gated");
}
if (import.meta.main) {
  const config = options(process.argv.slice(2));
  if (await stat(config.output).then(() => true).catch(() => false)) throw new Error("Use a new output directory; failed captures must be preserved");
  await withSignals(signal => campaign(config, signal));
}
