import { cleanupTimeoutMs } from "../goals-matrix/deadlines";
import { until } from "../goals-matrix/playground";
import { admit, Scope, type Admission } from "../goals-matrix/scope";
import type { Transport } from "../goals-matrix/transport";
import type { SandboxRootOutcome } from "./model";
import { installTimeoutMs, phaseTimeoutMs } from "./options";

const sandboxRootUrl = "http://127.0.0.1/";

interface SandboxProbe {
  ready: boolean;
  error?: string;
  status?: string;
  serverState?: string | null;
  buttonText?: string | null;
  databases?: string[];
}

const probeSandboxSource = `(async () => {
  const status = document.querySelector("#status");
  const kind = status?.getAttribute("data-kind") ?? "";
  const text = status?.textContent ?? "";
  if (kind === "error") return { ready: false, error: text || "sandbox error", status: text };
  const dot = document.querySelector("#server-dot")?.getAttribute("data-state") ?? null;
  const frame = document.querySelector("#preview");
  const button = frame && frame instanceof HTMLIFrameElement
    ? frame.contentDocument?.querySelector("button.counter:not([disabled])")
    : null;
  const ready = kind === "ok" && /dev server ready/.test(text) && dot === "up" && Boolean(button);
  if (!ready) return { ready: false, status: text, serverState: dot };
  const databases = (await indexedDB.databases()).map(db => db.name).filter(name => typeof name === "string");
  return { ready: true, status: text, serverState: dot, buttonText: button?.textContent ?? null, databases };
})()`;

const clickCounterSource = `(async () => {
  const frame = document.querySelector("#preview");
  const button = frame && frame instanceof HTMLIFrameElement
    ? frame.contentDocument?.querySelector("button.counter:not([disabled])")
    : null;
  if (!button || !(button instanceof HTMLElement)) return { clicked: false, text: null };
  const before = button.textContent ?? "";
  button.click();
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const after = button.textContent ?? "";
    if (after !== before && /count is 1/.test(after)) return { clicked: true, text: after };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { clicked: false, text: button.textContent ?? null };
})()`;

const flushAndDisposeSource = `(async () => {
  const api = globalThis.sandbox;
  if (!api) return;
  await api.fs.flush();
  await api.runtime.dispose();
})()`;

async function waitSandboxReady(transport: Transport, timeoutMs: number, admission: Admission): Promise<SandboxProbe> {
  return until(async () => {
    const result = await transport.evaluate<SandboxProbe>(probeSandboxSource, admission, { observation: true });
    if (result.error) throw new Error(`Root sandbox failed: ${result.error}`);
    return result;
  }, result => result.ready, Math.min(timeoutMs, admit(admission)));
}

async function runVisit(
  createTransport: () => Promise<Transport>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ durationMs: number; databases: string[]; buttonText: string | null }> {
  const transport = await createTransport();
  const started = performance.now();
  let result: { durationMs: number; databases: string[]; buttonText: string | null } | undefined;
  let runError: unknown;
  let cleanupError: unknown;
  const scope = Scope.open(timeoutMs, signal);
  try {
    result = await scope.run(async admission => {
      await transport.navigate(sandboxRootUrl, admission);
      const probe = await waitSandboxReady(transport, timeoutMs, admission);
      const databases = probe.databases ?? [];
      if (!databases.includes("bun-wasm-sandbox-vite-react")) {
        throw new Error(`Root sandbox did not persist bun-wasm-sandbox-vite-react; saw ${JSON.stringify(databases)}`);
      }
      const clicked = await transport.evaluate<{ clicked: boolean; text: string | null }>(clickCounterSource, admission);
      if (!clicked.clicked) {
        throw new Error(`Root sandbox counter did not increment after click; saw ${JSON.stringify(clicked.text)}`);
      }
      await transport.evaluate(flushAndDisposeSource, admission);
      return { durationMs: Math.round(performance.now() - started), databases, buttonText: clicked.text };
    });
  } catch (error) {
    runError = error;
  } finally {
    scope.close();
    const cleanupScope = Scope.open(cleanupTimeoutMs);
    try {
      await transport.beginCleanup?.(cleanupScope);
      if (transport.cleanup) await transport.cleanup(cleanupTimeoutMs);
      else await transport.close(true, cleanupTimeoutMs);
    } catch (error) {
      cleanupError = error;
    } finally {
      cleanupScope.close();
    }
  }
  if (runError !== undefined && cleanupError !== undefined) throw new AggregateError([runError, cleanupError], "Root sandbox visit and cleanup failed");
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
  return result!;
}

/**
 * Verifies the live `/` root sandbox on default persistent IndexedDB storage (not `mode=memory`),
 * then reopens `/` on the same Safari profile to confirm clean persistent-FS reload.
 */
export async function runIphoneSandboxRoot(
  createTransport: () => Promise<Transport>,
  signal?: AbortSignal,
): Promise<SandboxRootOutcome> {
  try {
    const initial = await runVisit(createTransport, installTimeoutMs, signal);
    const reload = await runVisit(createTransport, phaseTimeoutMs, signal);
    return {
      url: sandboxRootUrl,
      status: "pass",
      initialMs: initial.durationMs,
      reloadMs: reload.durationMs,
      databases: reload.databases,
    };
  } catch (error) {
    return {
      url: sandboxRootUrl,
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
