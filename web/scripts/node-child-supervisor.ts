import { parentPort, Worker, workerData, type WorkerOptions } from "node:worker_threads";
import { childTransport, type ChildTransport } from "../src/subprocess.ts";

const data: { entry: string; options: WorkerOptions; transport: ChildTransport } = workerData;
const child = childTransport(data.transport);
const control = new Int32Array(data.transport.control);
function supervise() {
  let guest: Worker;
  try { guest = new Worker(new URL(data.entry), data.options); }
  catch {
    child.startFailed("EACCES");
    parentPort?.close();
    return;
  }
  guest.on("error", error => {
    child.stderr.write(new TextEncoder().encode(`bun-wasm: ${error.stack || error}\n`));
    if (Atomics.load(control, 2) === 0) child.startFailed("EACCES");
    else child.finish(1);
  });
  guest.on("exit", code => {
    if (Atomics.load(control, 2) === 0) child.startFailed("EACCES");
    else child.finish(code);
    parentPort?.close();
  });
  parentPort?.on("message", () => { void guest.terminate(); });
}
supervise();
