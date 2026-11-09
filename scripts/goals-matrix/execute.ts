import { cleanupTimeoutMs } from "./deadlines";
import { angularDiagnostic, namedAngularDiagnostic } from "./angular-diagnostic";
import type { Framework, Box } from "./catalog";
import { finish, type Attempt, type Cell, type Phase, type PhaseResult } from "./model";
import type { Transport } from "./transport";
import { checkClick, command, edit, ready, render, start, openPreview, stopServer, terminal } from "./playground";
export interface Execution {
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
type FailureLog = { text: string; diagnostic: string; saved: boolean };
export async function bounded<T>(operation: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Matrix interrupted"));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => reject(new Error(`Phase timed out after ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
async function phase(results: PhaseResult[], name: Phase, timeoutMs: number, operation: () => Promise<unknown>, signal?: AbortSignal): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const evidence = await bounded(operation, timeoutMs, signal);
    results.push({ phase: name, status: "pass", startedAt, timeoutMs, durationMs: Math.round(performance.now() - started), evidence });
  } catch (error) {
    results.push({ phase: name, status: "fail", startedAt, timeoutMs, durationMs: Math.round(performance.now() - started), error: String(error) });
    throw error;
  }
}
export async function execute(options: Execution, earlier: readonly Attempt[] = []): Promise<Cell> {
  const results: PhaseResult[] = [];
  const startedAt = new Date().toISOString();
  let transport: Transport | undefined;
  let creation: Promise<Transport> | undefined;
  let closing = false;
  let capabilities: Record<string, unknown> = {};
  let failureLog: FailureLog | undefined;
  try {
    await phase(results, "startup", options.timeoutMs, async () => {
      creation = options.createTransport().then(async owned => {
        if (closing) { await owned.close(); throw new Error("Transport created after startup deadline and closed"); }
        transport = owned;
        return owned;
      });
      transport = await creation;
      capabilities = transport.capabilities;
      await transport.navigate(options.url);
      return ready(transport, options.box.engine, options.timeoutMs);
    }, options.signal);
    if (!transport) throw new Error("Transport not created");
    await lifecycle(transport, options, results);
  } catch {
    if (transport) failureLog = await captureFailure(transport, options, results);
  }
  finally {
    closing = true;
    await phase(results, "cleanup", cleanupTimeoutMs, async () => {
      const pending = creation;
      if (!transport && pending) await bounded(() => pending.catch(() => undefined), 10_000);
      return cleanup(transport, options, results, failureLog);
    }).catch(() => {});
  }
  return finish(options.box, { startedAt, finishedAt: new Date().toISOString(), phases: results, browser: capabilities }, earlier);
}
async function lifecycle(transport: Transport, options: Execution, results: PhaseResult[]): Promise<void> {
  const { framework, timeoutMs, port = 5173 } = options;
  const check = (name: Phase, operation: () => Promise<unknown>) => phase(results, name, timeoutMs, operation, options.signal);
  const installTimeoutMs = options.installTimeoutMs ?? timeoutMs;
  await phase(results, "install", installTimeoutMs, () => command(transport, "bun install", installTimeoutMs), options.signal);
  let previewUrl = "";
  await check("dev", async () => { previewUrl = await start(transport, framework.rootPreview?.dev.replaceAll("{port}", String(port)) ?? "bun run dev", timeoutMs, port); return { url: previewUrl, port }; });
  await check("render", async () => { await openPreview(transport, timeoutMs, port); return render(transport, framework, framework.text, timeoutMs); });
  await check("click", () => checkClick(transport, framework, timeoutMs));
  await check("hot-reload", () => edit(transport, framework, timeoutMs));
  const buildTimeoutMs = options.buildTimeoutMs ?? timeoutMs;
  await phase(results, "build", buildTimeoutMs, async () => {
    await transport.closePreview();
    await stopServer(transport, Math.min(timeoutMs, 15_000), port);
    return command(transport, "bun run build", buildTimeoutMs);
  }, options.signal);
  await check("preview", async () => {
    await start(transport, framework.id === "vite-react" ? "bun run node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort" : framework.rootPreview?.start.replaceAll("{port}", String(port)) ?? "bun run start", timeoutMs, port);
    await openPreview(transport, timeoutMs, port);
    const rendered = await render(transport, framework, `${framework.text} hot updated`, timeoutMs);
    const clicked = await checkClick(transport, framework, timeoutMs);
    return { rendered, clicked };
  });
}

async function captureFailure(transport: Transport, options: Execution, results: PhaseResult[]): Promise<FailureLog | undefined> {
  let text = "";
  let diagnostic = "";
  const deadline = Date.now() + 2000;
  try {
    await bounded(async () => {
      text = await terminal(transport);
      if (options.framework.id !== "angular" || Date.now() >= deadline) return;
      const path = namedAngularDiagnostic(text);
      if (!path) return;
      diagnostic = `\n\nGuest Angular diagnostic unavailable within failure observation: ${path}\n`;
      diagnostic = await angularDiagnostic(transport, path, deadline);
    }, 2000);
  } catch { if (!text) return; }
  const concrete = text.split("\n").find(line => /(?:Error:|error:|panic|Exception|RuntimeError|TypeError)/.test(line));
  const failed = results.find(result => result.status === "fail");
  if (concrete && failed?.status === "fail") failed.error += `; terminal: ${concrete.slice(0, 1000)}`;
  text += diagnostic;
  try {
    await bounded(() => options.saveLog(text), 2000);
    return { text, diagnostic, saved: true };
  } catch { return { text, diagnostic, saved: false }; }
}

async function cleanup(transport: Transport | undefined, options: Execution, results: readonly PhaseResult[], failureLog: FailureLog | undefined): Promise<unknown> {
  if (!transport) return { transportCreated: false };
  const ownedCleanup = transport.cleanup?.bind(transport);
  if (ownedCleanup) return cleanupOwned(transport, options, results, failureLog, ownedCleanup);
  const errors: unknown[] = [];
  try { await bounded(async () => { await transport.closePreview(); await stopServer(transport, 5_000, options.port); await options.saveLog(await terminal(transport) + (failureLog?.diagnostic ?? "")); }, 8_000); }
  catch (error) { errors.push(error); }
  try { await bounded(() => transport.close(true, 10_000), 10_000); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  return { browserClosed: true, foregroundStopped: true, previewClosed: true };
}

async function cleanupOwned(transport: Transport, options: Execution, results: readonly PhaseResult[], failureLog: FailureLog | undefined, close: NonNullable<Transport["cleanup"]>): Promise<unknown> {
  const errors: unknown[] = [];
  try { await bounded(() => saveFinalLog(transport, options, results, failureLog), 4_000); }
  catch (error) { errors.push(error); }
  let evidence: unknown;
  try { evidence = await bounded(() => close(10_000), 10_000); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  return evidence;
}

async function saveFinalLog(transport: Transport, options: Execution, results: readonly PhaseResult[], failureLog: FailureLog | undefined): Promise<void> {
  let output: string;
  try { output = await bounded(() => terminal(transport), 2_000) + (failureLog?.diagnostic ?? ""); }
  catch (error) {
    if (failureLog?.saved) return;
    const transcript = completedTranscript(results);
    output = failureLog?.text ?? `Final terminal observation unavailable: ${String(error)}\n\n${transcript ?? "No completed command transcript was available."}`;
  }
  await bounded(() => options.saveLog(output), 2_000);
}

function completedTranscript(results: readonly PhaseResult[]): string | undefined {
  const phase = results.findLast(result => result.status === "pass" && (result.phase === "build" || result.phase === "install"));
  if (phase?.status !== "pass") return;
  const evidence = phase.evidence;
  if (evidence && typeof evidence === "object" && "output" in evidence && typeof evidence.output === "string") return evidence.output;
}
