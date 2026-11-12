import { cp, mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bounded } from "../goals-matrix/bounded";
import { ownedCommand } from "../goals-matrix/lifetime";
import { immutableIdentity, mutableRoots, nextOutputs, type Bracket, type LifecycleCell, type LifecycleOutcome } from "./lifecycle-model";
import { launchProcess, processIdentity, processTree } from "./lifecycle-process";
import { createPlaywrightTransport, type Transport } from "../goals-matrix/transport";
import { until, render, checkClick } from "../goals-matrix/playground";
import { frameworks } from "../goals-matrix/catalog";
import { verifyInstalledPacket, verifyExactFixture } from "./lifecycle-input";
import { sha256 } from "./input";
import { captureExecution, type RecordExecution } from "./lifecycle-evidence";

async function previewPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port;
  await server.stop(true);
  if (!port) throw new Error("No preview port");
  return port;
}
export async function resetNativeCache(root: string, workload: "next" | "vite") {
  const paths = mutableRoots[workload];
  for (const path of paths) await rm(join(root, path), { recursive: true, force: true });
  const present = await Promise.all(paths.map(path => stat(join(root, path)).then(() => true).catch(error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })));
  if (present.some(Boolean)) throw new Error("Native cold-cache reset failed");
  return { observedMs: performance.now(), paths: paths.slice(), absent: true, state: "absent immediately before submission" };
}
async function viteOutcome(transport: Transport, url: string, timeoutMs: number): Promise<LifecycleOutcome> {
  const beforeListening = performance.now();
  await until(async () => fetch(url).then(response => response.ok).catch(() => false), Boolean, timeoutMs);
  const listening = { beforeMs: beforeListening, afterMs: performance.now() };
  const beforeRender = performance.now();
  await transport.navigate(url);
  const framework = frameworks.find(item => item.id === "vite-react");
  if (!framework) throw new Error("Missing Vite React definition");
  await render(transport, framework, framework.text, timeoutMs);
  const rendered = { beforeMs: beforeRender, afterMs: performance.now() };
  const beforeCounter = performance.now();
  const counter = await checkClick(transport, framework, timeoutMs);
  if (!counter || typeof counter !== "object" || !("before" in counter) || !("after" in counter) || typeof counter.before !== "string" || typeof counter.after !== "string") throw new Error("Missing counter evidence");
  return { kind: "vite", listening, rendered, counter: { beforeMs: beforeCounter, afterMs: performance.now() }, before: counter.before, after: counter.after };
}

export async function nativeLifecycle(cell: LifecycleCell, prepared: string, scratch: string, output: string, timeoutMs: number, signal: AbortSignal, mode: "timing" | "selection" = "timing") {
  return captureExecution(output, ["command", "env", "runtime", "browser", "actualProcess", "control", "inputs", "reset", "completion"], record => prepareNative(cell, prepared, scratch, output, timeoutMs, signal, mode, record));
}
async function prepareNative(cell: LifecycleCell, prepared: string, scratch: string, output: string, timeoutMs: number, signal: AbortSignal, mode: "timing" | "selection", record: RecordExecution) {
  if (cell.arm.kind !== "native") throw new Error("Expected native lifecycle arm");
  const root = await mkdtemp(join(scratch, cell.id + "-"));
  try {
    await cp(join(prepared, cell.workload), root, { recursive: true, verbatimSymlinks: true });
    verifyInstalledPacket(root, join(prepared, `${cell.workload}-inventory.json`));
    verifyExactFixture(root, cell.workload);
    return await measureNative(cell, root, output, timeoutMs, signal, mode, record);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function measureNative(cell: LifecycleCell, root: string, output: string, timeoutMs: number, signal: AbortSignal, mode: "timing" | "selection", record: RecordExecution) {
  if (cell.arm.kind !== "native") throw new Error("Expected native lifecycle arm");
  const executable = Bun.which(cell.arm.runtime);
  if (!executable) throw new Error(`Missing ${cell.arm.runtime}`);
  const executableSha256 = sha256(await readFile(executable));
  record("runtime", { executable, executableSha256 });
  const env = { PATH: process.env.PATH, HOME: join(output, "home"), TMPDIR: join(output, "tmp"), NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: cell.workload === "next" ? "production" : "development",
    ...(mode === "selection" ? { LIFECYCLE_SELECTION_OUTPUT: join(output, "selection.jsonl"), NODE_OPTIONS: cell.arm.runtime === "node" ? `--require=${resolve("scripts/performance/lifecycle-selection.ts")}` : undefined } : {}) };
  record("env", env);
  let preview: Transport | null = null;
  let job: ReturnType<typeof launchProcess> | undefined;
  let timing: { submission: Bracket; completion: Bracket | null } | null = null;
  try {
    await mkdir(env.HOME); await mkdir(env.TMPDIR);
    const control = await ownedCommand([executable, "-e", "process.stdout.write(JSON.stringify({execPath:process.execPath,argv:process.argv,versions:process.versions}))"], signal);
    record("control", JSON.parse(control));
    const inputs = immutableIdentity(root, cell.workload);
    record("inputs", { before: inputs, after: null, valid: null, reason: "Post-run observation not reached" });
    preview = cell.arm.browser ? await createPlaywrightTransport(cell.arm.browser, timeoutMs, 10_000) : null;
    const previewProcesses = preview ? await processTree(process.pid) : null;
    record("browser", preview ? { ...preview.capabilities, headless: true, launchProcesses: previewProcesses, display: null, renderer: null } : null);
    const port = preview ? await previewPort() : null;
    const reset = await resetNativeCache(root, cell.workload);
    record("reset", reset);
    const preload = mode === "selection" && cell.arm.runtime === "bun" ? ["--preload", resolve("scripts/performance/lifecycle-selection.ts")] : [];
    const command = [executable].concat(preload, cell.workload === "next" ? ["node_modules/next/dist/bin/next", "build"] : ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"]);
    record("command", command);
    const submission = { beforeMs: performance.now(), afterMs: 0 };
    job = launchProcess(command, root, env, output);
    const running = job;
    submission.afterMs = performance.now();
    timing = { submission, completion: null };
    const actualProcess = await processIdentity(job.child.pid);
    record("actualProcess", actualProcess);
    const outcome = await bounded(async (): Promise<LifecycleOutcome> => {
      if (preview) return viteOutcome(preview, `http://127.0.0.1:${port}/`, timeoutMs);
      const exitCode = await running.exited;
      const outputs = await Promise.all(nextOutputs.map(async path => stat(join(root, path)).then(info => ({ path, bytes: info.size })).catch(error => ({ path, bytes: null, reason: String(error) }))));
      return { kind: "next", exitCode, outputs };
    }, timeoutMs, signal);
    const completion = outcome.kind === "vite" ? outcome.counter : job.observation.exit;
    if (!completion) throw new Error("Missing process-close observation");
    timing.completion = completion;
    record("completion", completion);
    if (preview) await job.close();
    const after = immutableIdentity(root, cell.workload);
    record("inputs", { before: inputs, after, valid: inputs === after });
    return { outcome, submission, completion, wallMs: completion.afterMs - submission.beforeMs, command, env, actualProcess, executableSha256,
      browser: preview ? { ...preview.capabilities, headless: true, launchProcesses: previewProcesses, display: null, renderer: null, unavailableReason: "Headless experimental preview" } : null,
      control: JSON.parse(control), inputs: { before: inputs, after, valid: inputs === after }, reset };
  } finally {
    const savedTiming = writeFile(join(output, "timing.json"), JSON.stringify({ ...timing, failureObservedMs: timing?.completion ? null : performance.now(), unit: "ms", clock: "controller performance.now", method: "native process-close event or preview observation", wallMs: timing?.completion ? timing.completion.afterMs - timing.submission.beforeMs : null }));
    const stopped = await Promise.allSettled([savedTiming, job?.close(), preview?.close()]);
    await rm(env.HOME, { recursive: true, force: true }); await rm(env.TMPDIR, { recursive: true, force: true });
    const errors = stopped.filter(result => result.status === "rejected").map(result => String(result.reason));
    await writeFile(join(output, "cleanup.json"), JSON.stringify({ resourcesStopped: errors.length === 0, errors }));
  }
}
