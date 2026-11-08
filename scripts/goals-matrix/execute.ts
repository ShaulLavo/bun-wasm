import type { Framework, Box } from "./catalog";
import { finish, type Attempt, type Cell, type Phase, type PhaseResult } from "./model";
import type { Transport } from "./transport";
import { checkClick, command, edit, ready, render, start, stopServer, terminal } from "./playground";
export interface Execution {
  box: Box;
  framework: Framework;
  url: string;
  timeoutMs: number;
  createTransport(): Promise<Transport>;
  saveLog(text: string): Promise<void>;
}
export async function bounded<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Phase timed out after ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function phase(results: PhaseResult[], name: Phase, timeoutMs: number, operation: () => Promise<unknown>): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const evidence = await bounded(operation, timeoutMs);
    results.push({ phase: name, status: "pass", startedAt, durationMs: Math.round(performance.now() - started), evidence });
  } catch (error) {
    results.push({ phase: name, status: "fail", startedAt, durationMs: Math.round(performance.now() - started), error: String(error) });
    throw error;
  }
}
export async function execute(options: Execution, earlier: readonly Attempt[] = []): Promise<Cell> {
  const results: PhaseResult[] = [];
  const startedAt = new Date().toISOString();
  let transport: Transport | undefined;
  let capabilities: Record<string, unknown> = {};
  try {
    await phase(results, "startup", options.timeoutMs, async () => {
      transport = await options.createTransport();
      capabilities = transport.capabilities;
      await transport.navigate(options.url);
      return ready(transport, options.box.engine, options.timeoutMs);
    });
    if (!transport) throw new Error("Transport not created");
    await lifecycle(transport, options, results);
  } catch { /* The first failed phase already owns the concrete error. */ }
  finally {
    await phase(results, "cleanup", 20_000, () => cleanup(transport, options)).catch(() => {});
  }
  return finish(options.box, { startedAt, finishedAt: new Date().toISOString(), phases: results, browser: capabilities }, earlier);
}
async function lifecycle(transport: Transport, options: Execution, results: PhaseResult[]): Promise<void> {
  const { framework, timeoutMs } = options;
  await phase(results, "install", timeoutMs, () => command(transport, "bun install", timeoutMs));
  let previewUrl = "";
  await phase(results, "dev", timeoutMs, async () => { previewUrl = await start(transport, "bun run dev", timeoutMs); return { url: previewUrl }; });
  await phase(results, "render", timeoutMs, async () => { await transport.openPreview(previewUrl); return render(transport, framework, framework.text, timeoutMs); });
  await phase(results, "click", timeoutMs, () => checkClick(transport, framework, timeoutMs));
  await phase(results, "hot-reload", timeoutMs, () => edit(transport, framework, timeoutMs));
  await phase(results, "build", timeoutMs, async () => {
    await transport.closePreview();
    await stopServer(transport, Math.min(timeoutMs, 15_000));
    return command(transport, "bun run build", timeoutMs);
  });
  await phase(results, "preview", timeoutMs, async () => {
    const url = await start(transport, framework.id === "vite-react" ? "bun run node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5173 --strictPort" : "bun run start", timeoutMs);
    await transport.openPreview(url);
    const rendered = await render(transport, framework, `${framework.text} hot updated`, timeoutMs);
    const clicked = await checkClick(transport, framework, timeoutMs);
    return { rendered, clicked };
  });
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
