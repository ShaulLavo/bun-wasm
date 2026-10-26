export type Pending = { kind: "command"; token: string; offset: number } | { kind: "server"; port: number; offset: number; entered: boolean } | undefined;

export function liveServer(pending: Pending, phase: number, ports: ReadonlyMap<number, unknown>) {
  return pending?.kind === "server" && pending.entered && phase !== 1 && ports.has(pending.port);
}

export function requireLiveServer(pending: Pending, phase: number, ports: ReadonlyMap<number, unknown>) {
  if (!liveServer(pending, phase, ports)) throw new Error("Ctrl-C requires a live foreground server and its expected listener");
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

export async function exitAfterDeadline(options: {
  primary: Error;
  cleanup: () => unknown | Promise<unknown>;
  timeout: number;
  report: (error: unknown) => void;
  exit: () => void;
}) {
  options.report(options.primary);
  try { await bounded(Promise.resolve().then(options.cleanup), options.timeout, "overall cleanup"); }
  catch (error) { options.report(error); }
  finally { options.exit(); }
}

export async function withProgress<T>(
  progress: { app: string; stage: string; operation: string },
  execute: () => Promise<T>,
  log: (message: string) => void,
) {
  log(JSON.stringify({ app: progress.app, stage: progress.stage, status: "progress", operation: progress.operation }));
  return execute();
}
