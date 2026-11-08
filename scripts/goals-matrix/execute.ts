import { cleanupTimeoutMs } from "./deadlines";
import type { Framework, Box } from "./catalog";
import { finish, type Attempt, type Cell, type Phase, type PhaseResult } from "./model";
import type { Transport } from "./transport";
import { checkClick, command, edit, ready, render, start, stopServer, terminal } from "./playground";
export interface Execution {
  box: Box;
  framework: Framework;
  url: string;
  timeoutMs: number;
  installTimeoutMs?: number;
  createTransport(): Promise<Transport>;
  saveLog(text: string): Promise<void>;
  signal?: AbortSignal;
}
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
    if (transport) await captureFailure(transport, options, results);
  }
  finally {
    closing = true;
    await phase(results, "cleanup", cleanupTimeoutMs, async () => {
      const pending = creation;
      if (!transport && pending) await bounded(() => pending.catch(() => undefined), 10_000);
      return cleanup(transport, options);
    }).catch(() => {});
  }
  return finish(options.box, { startedAt, finishedAt: new Date().toISOString(), phases: results, browser: capabilities }, earlier);
}
async function lifecycle(transport: Transport, options: Execution, results: PhaseResult[]): Promise<void> {
  const { framework, timeoutMs } = options;
  const check = (name: Phase, operation: () => Promise<unknown>) => phase(results, name, timeoutMs, operation, options.signal);
  const installTimeoutMs = options.installTimeoutMs ?? timeoutMs;
  await phase(results, "install", installTimeoutMs, () => command(transport, "bun install", installTimeoutMs), options.signal);
  let previewUrl = "";
  await check("dev", async () => { previewUrl = await start(transport, "bun run dev", timeoutMs); return { url: previewUrl }; });
  await check("render", async () => { await transport.openPreview(previewUrl); return render(transport, framework, framework.text, timeoutMs); });
  await check("click", () => checkClick(transport, framework, timeoutMs));
  await check("hot-reload", () => edit(transport, framework, timeoutMs));
  await check("build", async () => {
    await transport.closePreview();
    await stopServer(transport, Math.min(timeoutMs, 15_000));
    return command(transport, "bun run build", timeoutMs);
  });
  await check("preview", async () => {
    const url = await start(transport, framework.id === "vite-react" ? "bun run node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort" : "bun run start", timeoutMs);
    await transport.openPreview(url);
    const rendered = await render(transport, framework, `${framework.text} hot updated`, timeoutMs);
    const clicked = await checkClick(transport, framework, timeoutMs);
    return { rendered, clicked };
  });
}

async function captureFailure(transport: Transport, options: Execution, results: PhaseResult[]): Promise<void> {
  try {
    const text = await bounded(() => terminal(transport), 2000);
    await options.saveLog(text);
    const concrete = text.split("\n").find(line => /(?:Error:|error:|panic|Exception|RuntimeError|TypeError)/.test(line));
    const failed = results.find(result => result.status === "fail");
    if (concrete && failed?.status === "fail") failed.error += `; terminal: ${concrete.slice(0, 1000)}`;
  } catch { }
}

async function cleanup(transport: Transport | undefined, options: Execution): Promise<unknown> {
  if (!transport) return { transportCreated: false };
  const errors: unknown[] = [];
  try { await bounded(async () => { await transport.closePreview(); await stopServer(transport, 5_000); await options.saveLog(await terminal(transport)); }, 8_000); }
  catch (error) { errors.push(error); }
  try { await bounded(() => transport.close(), 10_000); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  return { browserClosed: true, foregroundStopped: true, previewClosed: true };
}
