import { FilesystemClient, type FilesystemCompletion } from "waffle/fs/client";
import type { Runtime } from "waffle";

declare const playground: { fs?: Pick<Runtime["filesystem"], "fork"> };
declare global { var __goalsReadAngularDiagnostic: ((input: { path: string; deadline: number }) => Promise<string>) | undefined; }

async function readDiagnostic(input: { path: string; deadline: number }): Promise<string> {
  const fs = playground.fs;
  if (!fs) throw new Error("Guest filesystem unavailable");
  if (Date.now() >= input.deadline) throw new Error("Failure observation deadline expired");
  const client = new FilesystemClient(fs.fork());
  const pending: FilesystemCompletion[] = [];
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    for (const completion of pending) completion.release();
    client.dispose();
  }
  // Leave cancellation time inside the existing outer observation deadline.
  const timer = setTimeout(close, Math.max(0, input.deadline - Date.now() - 25));
  async function request(operation: string, args: unknown[]): Promise<unknown> {
    if (Date.now() >= input.deadline) throw new Error("Failure observation deadline expired");
    const completion = client.submit(operation, args);
    // Resolve responses pin their returned handles until release. Keep those pins through read.
    pending.push(completion);
    return completion.value();
  }
  try {
    let directory = await request("preopen", ["/"]);
    if (typeof directory !== "number") throw new Error("Guest root unavailable");
    for (const component of input.path.slice(1).split("/")) {
      const resolved = await request("resolve", [directory, component, false]);
      if (!resolved || typeof resolved !== "object" || !("node" in resolved) || typeof resolved.node !== "number") throw new Error("Diagnostic path unavailable");
      directory = resolved.node;
      const stat = await request("stat", [directory]);
      const expected = component === "angular-errors.log" ? "file" : "directory";
      if (!stat || typeof stat !== "object" || !("kind" in stat) || stat.kind !== expected) throw new Error("Diagnostic path is non-regular or a symlink");
    }
    const stat = await request("stat", [directory]);
    if (!stat || typeof stat !== "object" || !("size" in stat) || typeof stat.size !== "number") throw new Error("Diagnostic size unavailable");
    const bytes = await request("read", [directory, 16_384, Math.max(0, stat.size - 16_384)]);
    if (!(bytes instanceof Uint8Array)) throw new Error("Diagnostic bytes unavailable");
    const lines = new TextDecoder().decode(bytes).split("\n");
    const truncated = stat.size > bytes.length || lines.length > 100;
    return `${truncated ? "[truncated to last 16 KiB / 100 lines]\n" : ""}${lines.slice(-100).join("\n")}`;
  } finally {
    clearTimeout(timer);
    close();
  }
}

globalThis.__goalsReadAngularDiagnostic = readDiagnostic;
