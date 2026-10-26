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
