import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { closeOwnedBrowser } from "./app-matrix/cleanup.ts";
import { ChromiumScheduleError, runChromiumSchedule, type ChromiumDriver, type ChromiumSample } from "./app-matrix/engine-arms.ts";
import { sha256, type ArmRegistry } from "./engine-arm-registry.ts";
import { playgroundChromiumDriver, playgroundCompileObserver, playgroundFixtures, type PlaygroundWorkload } from "./engine-playground-driver.ts";
import { reduceChromiumSamples } from "./engine-comparison.ts";

export async function chromiumMeasurements(registry: ArmRegistry, workloads: readonly string[], driver: ChromiumDriver,
  checkpoint: (samples: readonly ChromiumSample[]) => Promise<void> = async () => {}, signal?: AbortSignal) {
  try {
    const samples = await runChromiumSchedule(registry, workloads, driver, { cleanupTimeoutMs: 5_000, checkpoint, signal });
    return { samples, cleanupError: null };
  } catch (error) {
    if (!(error instanceof ChromiumScheduleError)) throw error;
    await checkpoint(error.samples);
    return { samples: error.samples, cleanupError: error.cleanupError };
  }
}

interface ChromiumReport {
  schemaVersion: 1;
  scope: "experimental-chromium";
  armRegistry: ArmRegistry;
  url: string;
  workloads: readonly string[];
  method: string;
  fixtures: readonly { path: string; bytes: number; sha256: string }[];
  commands: readonly { workload: string; command: string }[];
  driverSources: Readonly<Record<string, string>>;
  samples: readonly ChromiumSample[];
  summaries: ReturnType<typeof reduceChromiumSamples>;
  cleanupError: string | null;
  error: string | null;
}

export async function runChromiumBenchmark(registry: ArmRegistry, url: string, output: string, workloads: readonly PlaygroundWorkload[]) {
  const { chromium } = await import("playwright");
  const { ready, run, writeFile: writeGuestFile } = await import("../web/tests/playground.mjs");
  const names = ["engine-ready"].concat(workloads.map(workload => workload.name));
  const fixtures = Array.from(playgroundFixtures(workloads), ([path, contents]) => ({ path, bytes: Buffer.byteLength(contents), sha256: sha256(contents) }));
  const sources = ["bench-engines.ts", "engine-chromium-bench.ts", "engine-playground-driver.ts", "engine-compile-observation.ts", "app-matrix/engine-arms.ts"];
  const driverSources = Object.fromEntries(await Promise.all(sources.map(async path => [path, sha256(await readFile(join(import.meta.dirname, path)))])));
  let report: ChromiumReport = { schemaVersion: 1, scope: "experimental-chromium", armRegistry: registry, url, workloads: names,
    method: "Fresh Chromium context for each arm and round. Engine-ready is page-to-ready wall time. Command durations use the existing playground foreground driver. These are not native cold/precompiled timings. Compile spans are null without direct host instrumentation. All registered outcomes remain in the denominator.",
    fixtures, commands: workloads.map(workload => ({ workload: workload.name, command: workload.command })), driverSources,
    samples: [], summaries: reduceChromiumSamples([], registry, names), cleanupError: null, error: null };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  const persist = async (samples: readonly ChromiumSample[]) => {
    report = { ...report, samples, summaries: reduceChromiumSamples(samples, registry, names) };
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  };
  let server: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  const controller = new AbortController();
  let campaign: ReturnType<typeof chromiumMeasurements> | undefined;
  let launching: Promise<Awaited<ReturnType<typeof chromium.launchServer>>> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    try {
      server ??= await launching;
      if (server) await closeOwnedBrowser(server, 5_000);
    }
    catch (error) { report = { ...report, cleanupError: [report.cleanupError, String(error)].filter(Boolean).join("\n") }; }
    await campaign?.catch(() => undefined);
    await persist(report.samples);
  })();
  const interrupt = () => { controller.abort("Interrupted"); report.error = "Interrupted"; void cleanup().finally(() => process.exit(130)); };
  const terminate = () => { controller.abort("Terminated"); report.error = "Terminated"; void cleanup().finally(() => process.exit(143)); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    server = await (launching = chromium.launchServer({ headless: true, timeout: 5_000 }));
    controller.signal.throwIfAborted();
    const browser = await chromium.connect(server.wsEndpoint());
    const driver = playgroundChromiumDriver({ browser, url, workloads, controls: { ready, run, writeFile: writeGuestFile }, timeoutMs: 180_000, cleanupTimeoutMs: 5_000, compileObserver: playgroundCompileObserver });
    const outcome = await (campaign = chromiumMeasurements(registry, names, driver, persist, controller.signal));
    report = { ...report, samples: outcome.samples, cleanupError: [report.cleanupError, outcome.cleanupError].filter(Boolean).join("\n") || null };
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    try { await cleanup(); }
    finally { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); }
  }
  assert.ok(report.cleanupError === null && report.samples.every(sample => sample.status === "pass"), "Chromium measurement contains failed, blocked or unconfirmed cleanup outcomes");
  return report;
}
