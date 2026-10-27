import type { ProductApi } from "./protocol";

export type Pending = { kind: "command"; token: string; offset: number } | { kind: "server"; port: number; offset: number; entered: boolean } | undefined;

export function liveServer(pending: Pending, phase: number, ports: ReadonlyMap<number, unknown>) {
  return pending?.kind === "server" && pending.entered && phase !== 1 && ports.has(pending.port);
}

export function requireLiveServer(pending: Pending, phase: number, ports: ReadonlyMap<number, unknown>) {
  if (!liveServer(pending, phase, ports)) throw new Error("Ctrl-C requires a live foreground server and its expected listener");
}

export function foregroundCycle(diagnostics: Pick<ReturnType<ProductApi["diagnostics"]>, "pending" | "liveServer">, stopped = false) {
  if (diagnostics.liveServer) return { blocked: undefined, available: stopped };
  if (diagnostics.pending !== undefined) return {
    blocked: "Foreground command has not completed; no live expected listener for Ctrl-C",
    available: false,
  };
  return { blocked: "Server returned to prompt before Ctrl-C", available: true };
}

export async function settleResources(tasks: readonly (() => unknown | Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const task of tasks) {
    try { await task(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Shell product cleanup failed");
}

export async function bounded<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), milliseconds); });
  try { return await Promise.race([promise, expired]); }
  finally { clearTimeout(timer); }
}

type DeadlineOptions = {
  primary: Error;
  cleanup: () => unknown | Promise<unknown>;
  timeout: number;
  report: (error: unknown) => void;
  exit: () => void;
  unverified?: () => string[];
};

function reportSafely(report: (error: unknown) => void, error: unknown) {
  try { report(error); } catch {}
}

function reportUnverified(options: DeadlineOptions) {
  try {
    const resources = options.unverified?.() ?? [];
    if (resources.length) reportSafely(options.report, new Error(`Unverified resources: ${resources.join(", ")}`));
  } catch (error) { reportSafely(options.report, error); }
}

export async function exitAfterDeadline(options: DeadlineOptions) {
  try {
    reportSafely(options.report, options.primary);
    await bounded(Promise.resolve().then(options.cleanup), options.timeout, "overall cleanup");
  } catch (error) {
    reportSafely(options.report, error);
    reportUnverified(options);
  } finally { options.exit(); }
}

export function createProductCleanup(options: {
  capture: () => unknown | Promise<unknown>;
  captureTimeout: number;
  closeBrowser: () => unknown | Promise<unknown>;
  stopServer: () => unknown | Promise<unknown>;
  closeMirror: () => unknown | Promise<unknown>;
  removeScratch: () => unknown | Promise<unknown>;
}) {
  let cleanupPromise: Promise<void> | undefined;
  const unverified = new Set(["browser close", "server stop", "mirror close", "scratch removal"]);
  async function track(name: string, task: () => unknown | Promise<unknown>) {
    await task();
    unverified.delete(name);
  }
  async function run() {
    const capture = bounded(Promise.resolve().then(options.capture), options.captureTimeout, "terminal capture");
    const closeBrowser = () => track("browser close", options.closeBrowser);
    const browser = capture.then(closeBrowser, closeBrowser);
    const server = track("server stop", options.stopServer);
    const mirror = track("mirror close", options.closeMirror);
    const consumers = Promise.allSettled([browser, server, mirror]);
    const scratch = consumers.then(results => {
      if (results.some(result => result.status === "rejected")) return;
      return track("scratch removal", options.removeScratch);
    });
    const results = await Promise.allSettled([capture, browser, server, mirror, scratch]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Shell product cleanup failed");
  }
  function cleanup() {
    return cleanupPromise ??= run();
  }
  return { cleanup, unverified: () => Array.from(unverified) };
}

export async function withProgress<T>(
  progress: { app: string; stage: string; operation: string },
  execute: () => Promise<T>,
  log: (message: string) => void,
) {
  log(JSON.stringify({ app: progress.app, stage: progress.stage, status: "progress", operation: progress.operation }));
  return execute();
}
