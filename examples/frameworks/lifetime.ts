import type { Server } from "node:http";

export function lifetime() {
  const acquired: (() => Promise<unknown>)[] = [];
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= drain(acquired);
    return closing;
  }
  return { own: (stop: () => Promise<unknown>) => acquired.push(stop), close };
}

async function drain(acquired: (() => Promise<unknown>)[]) {
  const failures: unknown[] = [];
  for (const stop of acquired.reverse()) {
    try { await stop(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "App shutdown failed");
}

export async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

export async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
