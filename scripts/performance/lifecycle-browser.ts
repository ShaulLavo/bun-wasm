import { captureExecution, type RecordExecution } from "./lifecycle-evidence";
import { startupControls, startObservation, finishObservation } from "./sharing-controls";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runtime } from "waffle";
import { command, ready, terminal, stopServer, start, openPreview, render, checkClick } from "../goals-matrix/playground";
import { createPlaywrightTransport, type Transport } from "../goals-matrix/transport";
import { playgroundURL } from "../goals-matrix/run";
import { frameworks } from "../goals-matrix/catalog";
import { canonical, sha256 } from "./input";
import { verifyResolution } from "./lifecycle-lock";
import { processTree } from "./lifecycle-process";
import { bounded } from "../goals-matrix/bounded";
import { mutableRoots, nextOutputs, type Bracket, type LifecycleCell, type LifecycleOutcome } from "./lifecycle-model";

declare const playground: { fs: Runtime["filesystem"] };
function expression<A, R>(fn: (value: A) => R, value: A): string { return `(${fn.toString()})(${JSON.stringify(value)})`; }
async function fingerprint(excludes: string[]) {
  const root = "/home/user/";
  const files = (await playground.fs.listFiles(root)).filter(path => !excludes.some(excluded => path === root + excluded || path.startsWith(root + excluded + "/"))).sort();
  const inventory: { path: string; sha256: string }[] = [];
  for (const path of files) {
    const data = await playground.fs.readFile(path);
    if (!data) throw new Error(`Immutable file unreadable: ${path}`);
    const digest = await crypto.subtle.digest("SHA-256", data.slice());
    inventory.push({ path, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") });
  }
  return inventory;
}
async function reset(paths: string[]) {
  for (const path of paths) await playground.fs.remove(`/home/user/${path}`);
  const remaining = await Promise.all(paths.map(path => playground.fs.lookup(`/home/user/${path}`)));
  if (remaining.some(Boolean)) throw new Error("Cold lifecycle cache reset failed");
  return { paths, absent: true, pageObservedMs: performance.now() };
}
async function outputs(paths: string[]) {
  return Promise.all(paths.map(async path => {
    const data = await playground.fs.readFile(`/home/user/${path}`);
    return data ? { path, bytes: data.byteLength } : { path, bytes: null, reason: "Guest fs.readFile returned no file" };
  }));
}
async function cleanupBrowser(transport: Transport, output: string): Promise<void> {
  try {
    const transcript = await bounded(() => terminal(transport), 3000).catch(String);
    await writeFile(join(output, "terminal.txt"), transcript);
    await bounded(() => stopServer(transport, 5000), 6000).catch(() => {});
  } finally {
    await bounded(() => transport.close(), 10_000);
    await writeFile(join(output, "cleanup.json"), JSON.stringify({ resourcesStopped: true, method: "Playwright browser.close resolved; context and its workers closed" }));
  }
}
function observedTransport(transport: Transport, observed: { completion: Bracket | null; lastPendingMs: number }, submission: Bracket): Transport {
  return { ...transport, async evaluate<T>(source: string, options?: { observation: true }): Promise<T> {
    const beforeMs = performance.now();
    const value = await transport.evaluate<T>(source, options);
    if (source.includes("playground.shell.submit")) {
      submission.beforeMs = beforeMs;
      submission.afterMs = performance.now();
      observed.lastPendingMs = beforeMs;
    }
    if (value && typeof value === "object" && "done" in value && "code" in value) {
      if (value.done === true) observed.completion = { beforeMs: observed.lastPendingMs, afterMs: performance.now() };
      else observed.lastPendingMs = beforeMs;
    }
    return value;
  } };
}
export async function browserLifecycle(cell: LifecycleCell, base: string, prepared: string, output: string, timeoutMs: number, signal: AbortSignal) {
  const result = await captureBrowser(cell, base, prepared, output, timeoutMs, signal, { mode: "timing", sharing: "shared" });
  if (result.outcome === null) throw new Error("Timing wrapper received a control-only result");
  return result;
}
export async function diagnosticBrowserLifecycle(cell: LifecycleCell, base: string, prepared: string, output: string, timeoutMs: number, signal: AbortSignal, options: { mode: "controls" | "observation" | "observer-off"; sharing: "shared" | "unshared" }) {
  return captureBrowser(cell, base, prepared, output, timeoutMs, signal, options);
}
async function captureBrowser(cell: LifecycleCell, base: string, prepared: string, output: string, timeoutMs: number, signal: AbortSignal, options: { mode: "timing" | "controls" | "observation" | "observer-off"; sharing: "shared" | "unshared" }) {
  return captureExecution(output, ["command", "env", "browser", "runtime", "inputs", "resolution", "reset", "completion"], record => measureBrowser(cell, base, prepared, output, timeoutMs, signal, options, record));
}
async function measureBrowser(cell: LifecycleCell, base: string, prepared: string, output: string, timeoutMs: number, signal: AbortSignal, { mode, sharing }: { mode: "timing" | "controls" | "observation" | "observer-off"; sharing: "shared" | "unshared" }, record: RecordExecution) {
  if (cell.arm.kind !== "goals-browser") throw new Error("Expected goals browser arm");
  record("command", mode === "controls" ? ["bun", ".perf-startup.ts", "leaf/root/starts"] : cell.workload === "next" ? ["NEXT_TELEMETRY_DISABLED=1", "bun", "run", "build"] : ["bun", "run", "dev"]);
  record("env", { overrides: mode !== "controls" && cell.workload === "next" ? { NEXT_TELEMETRY_DISABLED: "1" } : {}, inherited: "Guest runtime environment; see readiness observation" });
  const transport = await createPlaywrightTransport(cell.arm.browser, timeoutMs, 10_000, true);
  const interrupt = () => { void transport.close().catch(() => {}); };
  signal.addEventListener("abort", interrupt, { once: true });
  let observationAllowed = false;
  let observer: Awaited<ReturnType<typeof startObservation>> | null = null;
  let timing: { submission: Bracket; completion: Bracket | null } | null = null;
  try {
    record("browser", { ...transport.capabilities, headless: true, launchProcesses: transport.processRoot === undefined ? null : await processTree(transport.processRoot), display: null, renderer: null });
    const framework = frameworks.find(item => item.id === (cell.workload === "next" ? "next" : "vite-react"));
    if (!framework) throw new Error("Missing starter definition");
    await transport.navigate(playgroundURL(base, framework, cell.arm.engine, cell.arm.profile));
    const runtime = await ready(transport, cell.arm.engine, timeoutMs, cell.arm.profile);
    record("runtime", runtime);
    const browserProcesses = transport.processRoot === undefined ? { available: false, reason: "Browser subprocess root unavailable" } : await processTree(transport.processRoot);
    if (mode === "controls") {
      const controls = await startupControls(transport, output, timeoutMs, cell.arm.engine !== "browser" && sharing === "unshared");
      await writeFile(join(output, "startup-control.json"), JSON.stringify({ runtime, controls }));
      if (controls.some(control => control.status !== "pass")) throw new Error("Startup control failed; see startup-control.json");
      return { outcome: null, wallMs: null, inputs: { valid: true }, runtime, controls, controlOnly: true };
    }
    const lock = await readFile(join(prepared, cell.workload, "bun.lock"), "utf8");
    await transport.evaluate(expression(async text => playground.fs.writeFile("/home/user/bun.lock", text), lock));
    const install = await command(transport, "bun install", timeoutMs);
    await writeFile(join(output, "install.json"), JSON.stringify(install));
    const guestLock = await transport.evaluate<string>("(async () => new TextDecoder().decode(await playground.fs.readFile('/home/user/bun.lock')))()");
    await writeFile(join(output, "guest.bun.lock"), guestLock);
    await writeFile(join(output, "native.bun.lock"), lock);
    const resolution = verifyResolution(lock, guestLock);
    record("resolution", resolution);
    await command(transport, "bun install --frozen-lockfile", timeoutMs);
    if (mode === "observation" || mode === "observer-off") {
      const controls = await startupControls(transport, output, timeoutMs, cell.arm.engine !== "browser" && sharing === "unshared").catch(error => [{ mode: "setup", status: "fail", reason: String(error), observerCoverage: { cpu: "unavailable" } }]);
      await writeFile(join(output, "startup-control.json"), JSON.stringify({ runtime, controls }));
      observationAllowed = controls.every(control => control.status === "pass" && control.observerCoverage.cpu === "positive");
    }
    const beforeInventory = await transport.evaluate<Awaited<ReturnType<typeof fingerprint>>>(expression(fingerprint, mutableRoots[cell.workload]));
    await writeFile(join(output, "guest-inputs.json"), JSON.stringify(beforeInventory));
    const inputs = sha256(canonical(beforeInventory));
    record("inputs", { before: inputs, after: null, valid: null, reason: "Post-run observation not reached" });
    const resetEvidence = await transport.evaluate(expression(reset, mutableRoots[cell.workload]));
    record("reset", resetEvidence);
    if (mode === "observation") observer = observationAllowed ? await startObservation(transport.processRoot, "Browser subprocess tree; samples wholly inside framework command observation window; harness and asset server excluded") : { observer: null, unavailable: "Exact-context root/child observer control did not pass; see startup-control.json" };
    const submission = { beforeMs: performance.now(), afterMs: 0 };
    timing = { submission, completion: null };
    const observed: { completion: Bracket | null; lastPendingMs: number } = { completion: null, lastPendingMs: submission.beforeMs };
    const tracked = observedTransport(transport, observed, submission);
    const job = cell.workload === "next" ? command(tracked, "NEXT_TELEMETRY_DISABLED=1 bun run build", timeoutMs) : start(tracked, "bun run dev", timeoutMs);
    submission.afterMs = performance.now();
    const result = await bounded(() => job, timeoutMs, signal);
    let outcome: LifecycleOutcome;
    if (cell.workload === "next") outcome = { kind: "next", exitCode: 0, outputs: await transport.evaluate(expression(outputs, nextOutputs)) };
    else {
      const listening = { beforeMs: submission.beforeMs, afterMs: performance.now() };
      const renderBefore = performance.now();
      await openPreview(transport, timeoutMs);
      await render(transport, framework, framework.text, timeoutMs);
      const rendered = { beforeMs: renderBefore, afterMs: performance.now() };
      const counterBefore = performance.now();
      const click = await checkClick(transport, framework, timeoutMs);
      if (!click || typeof click !== "object" || !("before" in click) || !("after" in click) || typeof click.before !== "string" || typeof click.after !== "string") throw new Error("Missing counter evidence");
      outcome = { kind: "vite", listening, rendered, counter: { beforeMs: counterBefore, afterMs: performance.now() }, before: click.before, after: click.after };
      observed.completion = outcome.counter;
    }
    const completion = observed.completion;
    if (!completion) throw new Error("Missing successful-exit observation");
    timing.completion = completion;
    record("completion", completion);
    if (observer) { await finishObservation(observer, join(output, "observation.json"), { beforeMs: submission.beforeMs, afterMs: completion.afterMs }); observer = null; }
    if (cell.workload === "vite") await stopServer(transport, 5000);
    await transport.useHost();
    const afterInventory = await transport.evaluate<Awaited<ReturnType<typeof fingerprint>>>(expression(fingerprint, mutableRoots[cell.workload]));
    const afterInputs = sha256(canonical(afterInventory));
    record("inputs", { before: inputs, after: afterInputs, valid: inputs === afterInputs });
    return { outcome, submission, completion, wallMs: completion.afterMs - submission.beforeMs, command: cell.workload === "next" ? ["NEXT_TELEMETRY_DISABLED=1", "bun", "run", "build"] : ["bun", "run", "dev"],
      runtime, browser: { ...transport.capabilities, headless: true, launchProcesses: browserProcesses, display: null, renderer: null, unavailableReason: "Headless experimental transport" }, inputs: { before: inputs, after: afterInputs, valid: inputs === afterInputs }, resolution, reset: resetEvidence, result };
  } finally {
    if (observer) await finishObservation(observer, join(output, "observation.json"));
    try { await writeFile(join(output, "timing.json"), JSON.stringify({ ...timing, failureObservedMs: timing?.completion ? null : performance.now(), unit: "ms", clock: "controller performance.now", method: "command/DOM polling observation", wallMs: timing?.completion ? timing.completion.afterMs - timing.submission.beforeMs : null })); }
    finally { await cleanupBrowser(transport, output); signal.removeEventListener("abort", interrupt); }
  }
}
