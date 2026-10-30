// The esbuild-shaped worker of scripts/worker-group-lanes.test.ts, on its own thread: it answers
// each request on the port it got in workerData, then signals the request's buffer, as esbuild's
// sync API worker does (lib/main.js `workerThreadService`).
import { workerData } from "node:worker_threads";
import { allocate, attach, groupRuntime, type ChildSpec, type GroupBuffers } from "./group-runtime";

interface Request {
  sab: SharedArrayBuffer;
  /** Reply sizes in characters, each posted on the workerData port before the signal. */
  replies?: number[];
  /** Characters posted on parentPort first: they fill the control pipe of a pipe-routed reply. */
  fill?: number;
  delayMs?: number;
  /** Close parentPort, then signal; later requests to this worker are dropped. */
  closeParent?: boolean;
  /** Close the workerData port, then signal; packets already headed to it are never read. */
  closePort?: boolean;
  /** Post a new region holding 73 to the parent on parentPort. */
  shareBack?: boolean;
}

const { group: buffers, spec, sources } = workerData as { group: GroupBuffers; spec: ChildSpec; sources?: string };
const group = attach(buffers);
const member = groupRuntime({ group, pid: spec.pid, env: spec.env, sources });
member.threads.initialize();
const { port } = member.threads.workerData as { port: { postMessage(value: unknown): void } };
const parentPort = member.threads.parentPort!;

function answer(request: Request) {
  const view = new Int32Array(request.sab);
  if (request.fill) parentPort.postMessage("f".repeat(request.fill));
  for (const [index, size] of (request.replies ?? []).entries()) port.postMessage({ index, text: String(index % 10).repeat(size) });
  if (request.shareBack) {
    const shared = allocate(group, 16);
    new Int32Array(shared)[0] = 73;
    parentPort.postMessage({ shared });
  }
  if (request.closeParent) parentPort.close();
  if (request.closePort) (port as unknown as { close(): void }).close();
  Atomics.add(view, 0, 1);
  Atomics.notify(view, 0);
  // Stay busy until the parent has read: nothing posted above may still depend on this thread.
  Atomics.wait(view, 1, 0, 10_000);
}
parentPort.on("message", (request: Request) => {
  if (request.delayMs) setTimeout(() => answer(request), request.delayMs);
  else answer(request);
});
