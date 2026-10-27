import type { ChildProcess } from "node:child_process";

export interface CleanupFailure {
  operation: string;
  timedOut: boolean;
  error: string;
}

export class HarnessCleanupError extends Error {
  constructor(readonly failures: readonly CleanupFailure[], cause?: unknown) {
    super(failures.map(failure => `${failure.operation}: ${failure.error}`).concat(cause === undefined ? [] : [`Original failure: ${String(cause)}`]).join("\n"), { cause });
    this.name = "HarnessCleanupError";
  }
}

export async function boundedCleanup(operation: string, cleanup: () => unknown, deadlineMs = 10_000): Promise<CleanupFailure | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineError = new Error(`Harness cleanup exceeded ${deadlineMs}ms`);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(deadlineError), deadlineMs);
  });
  try {
    await Promise.race([Promise.resolve().then(cleanup), deadline]);
    return null;
  } catch (error) {
    return { operation, timedOut: error === deadlineError, error: String(error) };
  } finally { clearTimeout(timer); }
}

interface OwnedBrowser {
  close(): Promise<void>;
  kill(): Promise<void>;
  process(): ChildProcess;
}

async function forceCloseBrowser(browser: OwnedBrowser, failure: CleanupFailure, deadlineMs: number, cause?: unknown): Promise<never> {
  const killed = await boundedCleanup("browser-kill", () => browser.kill(), deadlineMs);
  const failures = killed ? [failure, killed] : [failure];
  const child = browser.process();
  if (child.exitCode === null && child.signalCode === null) failures.push({ operation: "browser-exit", timedOut: false, error: "Owned browser process is still running" });
  throw new HarnessCleanupError(failures, cause);
}

export async function closeOwnedBrowser(browser: OwnedBrowser, deadlineMs = 10_000): Promise<void> {
  const failure = await boundedCleanup("browser-close", () => browser.close(), deadlineMs);
  if (failure) await forceCloseBrowser(browser, failure, deadlineMs);
}

export function withCleanupFailures<Result extends { status: string }>(result: Result, failures: readonly CleanupFailure[]) {
  if (!failures.length) return result;
  if (result.status !== "pass") return { ...result, harnessCleanup: failures };
  return { ...result, status: "fail", blocker: "Harness cleanup failed after product assertions", product: result, harnessCleanup: failures };
}

export async function closeOwnedContext(context: { close(): Promise<void> }, browser: OwnedBrowser, deadlineMs = 10_000, cause?: unknown): Promise<void> {
  const failure = await boundedCleanup("context-close", () => context.close(), deadlineMs);
  if (!failure) return;
  await forceCloseBrowser(browser, failure, deadlineMs, cause);
}
