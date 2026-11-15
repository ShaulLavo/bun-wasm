import { DescriptorTable } from "waffle/core/descriptors";
import { createWorkerProcessTransport, WorkerProcessClient, type WorkerProcessTransport } from "waffle/proc/worker-client";

// The package binding and its bootstrap must consume the same installed Waffle peer.
export { bootstrap } from "waffle/browser/worker";
export { createFilesystemConnection } from "waffle/fs";
export { controlLoad } from "waffle/proc/control";
export const { ProcessReplaced }: { ProcessReplaced: new (message: string) => Error } =
  await import(new URL("../proc/exec.js", import.meta.resolve("waffle/browser/worker")).href);

export function childTransport(): WorkerProcessTransport {
  const root = createWorkerProcessTransport({ pid: 1, job: 1 });
  const descriptors = new DescriptorTable();
  let child: WorkerProcessTransport | undefined;
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export() { throw new Error("No inherited descriptors"); }, import() { throw new Error("No inherited descriptors"); }, discard() {} },
    postMessage(message) { if (message.operation === "spawn") child = message.transport; },
  });
  try { client.spawn(1, { executable: "/bin/bun", argv: ["bun"], env: {}, cwd: "/", fds: [], job: 0 }); }
  finally { descriptors.dispose(); }
  if (!child) throw new Error("No admitted child transport");
  return child;
}
