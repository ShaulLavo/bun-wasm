import { browserTrapLog } from "./browser-memory";
import { cleanupTimeoutMs } from "./deadlines";
import { angularDiagnostic, namedAngularDiagnostic } from "./angular-diagnostic";
import type { Framework, Box } from "./catalog";
import { finish, type Attempt, type Cell, type Phase, type PhaseResult } from "./model";
import { scoped, type ScopedTransport, type Transport } from "./transport";
import { admit, Scope, type Admission } from "./scope";
import type { PlaygroundProfile } from "../../web/src/playground/program-profile";
import { checkClick, command, edit, ready, render, start, openPreview, stopServer, terminal } from "./playground";
import { bounded } from "./bounded";
export { bounded } from "./bounded";
export interface Execution {
  profile?: PlaygroundProfile;
  box: Box;
  framework: Framework;
  url: string;
  port?: number;
  timeoutMs: number;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
  createTransport(): Promise<Transport>;
  saveLog(text: string): Promise<void>;
  signal?: AbortSignal;
}
type TerminalCapture = { status: "observed"; text: string } | { status: "unavailable"; reason: string };
type FailureLog = { terminal: TerminalCapture; diagnostic: string; saved: boolean };
async function phase(results: PhaseResult[], name: Phase, timeoutMs: number, operation: (admission: Admission) => Promise<unknown>, signal?: AbortSignal): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const scope = Scope.open(timeoutMs, signal);
  try {
    const evidence = await scope.run(operation);
    results.push({ phase: name, status: "pass", startedAt, timeoutMs, durationMs: Math.round(performance.now() - started), evidence });
  } catch (error) {
    results.push({ phase: name, status: "fail", startedAt, timeoutMs, durationMs: Math.round(performance.now() - started), error: String(error) });
    throw error;
  } finally { scope.close(new Error(`${name} phase ended`)); }
}
export async function execute(options: Execution, earlier: readonly Attempt[] = []): Promise<Cell> {
  const results: PhaseResult[] = [];
  const startedAt = new Date().toISOString();
  let transport: Transport | undefined;
  let creation: Promise<Transport> | undefined;
  let closing = false;
  let capabilities: Record<string, unknown> = {};
  let failureLog: FailureLog | undefined;
  function retainTransport(owned: Transport): Transport | Promise<Transport> {
    if (closing) return closeLateTransport(owned);
    transport = owned;
    return owned;
  }
  try {
    await phase(results, "startup", options.timeoutMs, async admission => {
      creation = options.createTransport().then(retainTransport);
      transport = await creation;
      capabilities = transport.capabilities;
      const page = scoped(transport, admission);
      await page.navigate(options.url);
      return ready(page, options.box.engine, options.timeoutMs, options.profile);
    }, options.signal);
    if (!transport) throw new Error("Transport not created");
    await lifecycle(transport, options, results);
  } catch {
    if (transport) failureLog = await captureFailure(transport, options, results);
  }
  finally {
    closing = true;
    await phase(results, "cleanup", cleanupTimeoutMs, async admission => {
      const pending = creation;
      if (!transport && pending) await bounded(() => pending.catch(() => undefined), 10_000);
      return cleanup(transport, options, results, failureLog, admission);
    }).catch(() => {});
  }
  return finish(options.box, { startedAt, finishedAt: new Date().toISOString(), phases: results, browser: capabilities }, earlier);
}
async function closeLateTransport(owned: Transport): Promise<never> {
  await owned.close();
  throw new Error("Transport created after startup deadline and closed");
}
async function lifecycle(transport: Transport, options: Execution, results: PhaseResult[]): Promise<void> {
  const { framework, timeoutMs, port = 5173 } = options;
  const check = (name: Phase, operation: (page: ScopedTransport) => Promise<unknown>) => phase(results, name, timeoutMs, admission => operation(scoped(transport, admission)), options.signal);
  const installTimeoutMs = options.installTimeoutMs ?? timeoutMs;
  await phase(results, "install", installTimeoutMs, admission => command(scoped(transport, admission), "bun install", installTimeoutMs), options.signal);
  let previewUrl = "";
  await check("dev", async page => { previewUrl = await start(page, framework.rootPreview?.dev.replaceAll("{port}", String(port)) ?? "bun run dev", timeoutMs, port); return { url: previewUrl, port }; });
  await check("render", async page => { await openPreview(page, timeoutMs, port); return render(page, framework, framework.text, timeoutMs); });
  await check("click", page => checkClick(page, framework, timeoutMs));
  await check("hot-reload", page => edit(page, framework, timeoutMs));
  const buildTimeoutMs = options.buildTimeoutMs ?? timeoutMs;
  await phase(results, "build", buildTimeoutMs, async admission => {
    const page = scoped(transport, admission);
    await page.closePreview();
    await stopServer(page, Math.min(timeoutMs, 15_000), port);
    return command(page, "bun run build", buildTimeoutMs);
  }, options.signal);
  await check("preview", async page => {
    await start(page, framework.id === "vite-react" ? "bun run node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort" : framework.rootPreview?.start.replaceAll("{port}", String(port)) ?? "bun run start", timeoutMs, port);
    await openPreview(page, timeoutMs, port);
    const rendered = await render(page, framework, `${framework.text} hot updated`, timeoutMs);
    const clicked = await checkClick(page, framework, timeoutMs);
    return { rendered, clicked };
  });
}

async function captureFailure(transport: Transport, options: Execution, results: PhaseResult[]): Promise<FailureLog> {
  const scope = Scope.open(2000);
  const capture: FailureLog = { terminal: { status: "unavailable", reason: "not completed" }, diagnostic: "", saved: false };
  try {
    await scope.run(admission => observeFailure(transport, options, capture, admission));
  } catch (error) {
    if (capture.terminal.status === "unavailable") capture.terminal = { status: "unavailable", reason: String(error) };
    if (capture.terminal.status === "observed" && options.box.engine === "browser" && !capture.diagnostic) capture.diagnostic = "\n\nBrowser core trap memory snapshots unavailable within the failure observation budget.\n";
  } finally { scope.close(); }
  if (capture.terminal.status === "unavailable") return capture;
  const text = capture.terminal.text;
  const concrete = text.split("\n").find(line => /(?:Error:|error:|panic|Exception|RuntimeError|TypeError)/.test(line));
  const failed = results.find(result => result.status === "fail");
  if (concrete && failed?.status === "fail") failed.error += `; terminal: ${concrete.slice(0, 1000)}`;
  try {
    await bounded(() => options.saveLog(text + capture.diagnostic), 2000);
    capture.saved = true;
  } catch { /* Final logging retains the observed terminal when a local save fails. */ }
  return capture;
}

async function observeFailure(transport: Transport, options: Execution, capture: FailureLog, admission: Admission): Promise<void> {
  const page = scoped(transport, admission);
  const text = await terminal(page);
  admit(admission);
  capture.terminal = { status: "observed", text };
  const diagnostic = await browserTrapLog(page, options.box.engine);
  admit(admission);
  capture.diagnostic = diagnostic;
  if (options.framework.id !== "angular") return;
  const path = namedAngularDiagnostic(text);
  if (!path) return;
  const browserDiagnostic = capture.diagnostic;
  capture.diagnostic += `\n\nGuest Angular diagnostic unavailable within failure observation: ${path}\n`;
  capture.diagnostic = browserDiagnostic + await angularDiagnostic(page, path, admission.deadline);
}

async function cleanup(transport: Transport | undefined, options: Execution, results: readonly PhaseResult[], failureLog: FailureLog | undefined, admission: Admission): Promise<unknown> {
  if (!transport) return { transportCreated: false };
  const ownedCleanup = transport.cleanup?.bind(transport);
  if (ownedCleanup) return cleanupOwned(transport, options, results, failureLog, ownedCleanup, admission);
  const errors: unknown[] = [];
  const work = Scope.open(8000, admission);
  try {
    await work.run(async guard => {
      const page = scoped(transport, guard);
      await transport.beginCleanup?.(guard);
      await page.closePreview();
      await stopServer(page, 5000, options.port);
      await saveFinalLog(transport, options, results, failureLog, guard);
    });
  } catch (error) { errors.push(error); }
  finally { work.close(); }
  try { await bounded(() => transport.close(true, 10_000), 10_000); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  return { browserClosed: true, foregroundStopped: true, previewClosed: true };
}

async function cleanupOwned(transport: Transport, options: Execution, results: readonly PhaseResult[], failureLog: FailureLog | undefined, close: NonNullable<Transport["cleanup"]>, admission: Admission): Promise<unknown> {
  const errors: unknown[] = [];
  const handoff = Scope.open(4000, admission);
  try {
    await handoff.run(async guard => {
      await transport.beginCleanup?.(guard);
      await saveFinalLog(transport, options, results, failureLog, guard);
    });
  } catch (error) { errors.push(error); }
  finally { handoff.close(); }
  let evidence: unknown;
  try { evidence = await bounded(() => close(10_000), 10_000); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  return evidence;
}

async function saveFinalLog(transport: Transport, options: Execution, results: readonly PhaseResult[], failureLog: FailureLog | undefined, parent: Admission): Promise<void> {
  const scope = Scope.open(2000, parent);
  let output: string;
  const observation: { terminal: TerminalCapture } = { terminal: { status: "unavailable", reason: "not completed" } };
  try {
    output = await scope.run(async guard => {
      const page = scoped(transport, guard);
      const text = await terminal(page);
      admit(guard);
      observation.terminal = { status: "observed", text };
      return text + (failureLog?.diagnostic || await browserTrapLog(page, options.box.engine));
    });
  }
  catch (error) {
    parent.signal.throwIfAborted();
    if (failureLog?.saved) return;
    output = finalLogFallback(observation.terminal, options.box.engine, results, failureLog, error);
  } finally { scope.close(); }
  await bounded(() => options.saveLog(output), 2000, parent.signal);
}

function finalLogFallback(terminal: TerminalCapture, engine: string, results: readonly PhaseResult[], failureLog: FailureLog | undefined, error: unknown): string {
  if (terminal.status === "observed") return terminal.text + (engine === "browser" ? "\n\nBrowser core trap memory snapshots unavailable within the final observation budget.\n" : "");
  if (failureLog?.terminal.status === "observed") return failureLog.terminal.text + failureLog.diagnostic;
  const capture = failureLog?.terminal.status === "unavailable" ? `\nFailure capture: ${failureLog.terminal.reason}` : "";
  return `Final terminal observation unavailable: ${String(error)}${capture}\n\n${completedTranscript(results) ?? "No completed command transcript was available."}`;
}

function completedTranscript(results: readonly PhaseResult[]): string | undefined {
  const phase = results.findLast(result => result.status === "pass" && (result.phase === "build" || result.phase === "install"));
  if (phase?.status !== "pass") return;
  const evidence = phase.evidence;
  if (evidence && typeof evidence === "object" && "output" in evidence && typeof evidence.output === "string") return evidence.output;
}
