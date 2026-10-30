// esbuild's synchronous API between real Bun processes of one memory group (shared-group QuickJS
// pair only; design.md "What the consumers need", item 3). Main blocks in Atomics.wait right after
// starting the worker; the worker posts its reply on a MessagePort, notifies, and then stays
// blocked, so main's receiveMessageOnPort sees the reply only if it was complete in shared memory
// before the notify. The worker first puts 640 KiB on parentPort, so a reply routed through the
// 1 MiB control pipe could not be complete there. Usage: bun esbuild-reply.ts (one PASS line per
// check, exits 1 on the first failure). A split pair fails at the first Worker with DataCloneError.
import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";
import type { MessagePort } from "node:worker_threads";

const KIB = 1024;
const FILL = 640 * KIB, REPLY = 640 * KIB;
const MEMBER_CYCLES = 20; // more than the group's 16-member cap: each cycle opens and settles lanes
// Words of a request buffer: 0 reply signal, 1 hold until main has read, 2 worker's plain store.
const SIGNAL = 0, HOLD = 1, STORE = 2;

interface Request {
  sab: SharedArrayBuffer;
  replies: number[];
  fill?: number;
  shareBack?: boolean;
  closePort?: boolean;
}

function answer(port: MessagePort, request: Request) {
  const view = new Int32Array(request.sab);
  view[STORE] = 42;
  if (request.fill) parentPort!.postMessage({ fill: "f".repeat(request.fill) });
  for (const [index, size] of request.replies.entries()) port.postMessage({ index, text: String(index % 10).repeat(size) });
  if (request.shareBack) {
    const shared = new SharedArrayBuffer(16);
    new Int32Array(shared)[0] = 73;
    parentPort!.postMessage({ shared });
  }
  if (request.closePort) port.close();
  Atomics.add(view, SIGNAL, 1);
  Atomics.notify(view, SIGNAL);
  // Stay busy until main has read: nothing posted above may still need this process to run.
  Atomics.wait(view, HOLD, 0, 30000);
}

if (!isMainThread) {
  const { port, mode } = workerData as { port: MessagePort; mode: "serve" | "block" | "cycle" };
  if (mode === "block") {
    const view = new Int32Array((workerData as { sab: SharedArrayBuffer }).sab);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
    Atomics.wait(view, 1, 0); // never notified: only termination ends this member
  }
  parentPort!.on("message", (request: Request) => answer(port, request));
} else {
  let failed = false;
  const check = (name: string, ok: boolean, detail: unknown = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` ${JSON.stringify(detail)}`}`);
    if (!ok) failed = true;
  };
  const exited = (worker: Worker) => new Promise<number>(resolve => worker.once("exit", resolve));
  const within = <T>(promise: Promise<T>, ms: number, what: string) =>
    Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
  const lengths = (messages: unknown[]) => messages.map(value => {
    const { index, text } = value as { index: number; text: string };
    return [index, text.length];
  });
  const self = new URL(import.meta.url).pathname;

  function service(mode: "serve" | "cycle" = "serve") {
    const { port1: mainPort, port2: workerPort } = new MessageChannel();
    const worker = new Worker(self, { workerData: { port: workerPort, mode }, transferList: [workerPort] });
    const exit = exited(worker);
    function call(request: Omit<Request, "sab">, waitMs = 30000) {
      const sab = new SharedArrayBuffer(16), view = new Int32Array(sab);
      worker.postMessage({ sab, ...request });
      const status = Atomics.wait(view, SIGNAL, 0, waitMs);
      const received: unknown[] = [];
      for (let message = receiveMessageOnPort(mainPort); message; message = receiveMessageOnPort(mainPort)) received.push(message.message);
      const release = () => { Atomics.store(view, HOLD, 1); Atomics.notify(view, HOLD); };
      return { status, received, view, release };
    }
    return { worker, mainPort, exit, call };
  }

  // The first call, before the worker has run at all: nothing on this side may need a loop turn.
  const first = service();
  const fills = new Promise<unknown>(resolve => first.worker.once("message", resolve));
  const reply = first.call({ fill: FILL, replies: [REPLY] });
  check("first call wakes", reply.status === "ok", reply.status);
  check("worker plain store visible at wake", reply.view[STORE] === 42, reply.view[STORE]);
  check("reply behind a full control pipe is complete at wake", JSON.stringify(lengths(reply.received)) === JSON.stringify([[0, REPLY]]), lengths(reply.received));
  reply.release();
  const fill = await within(fills, 30000, "parentPort fill").catch(error => String(error));
  check("parentPort message also arrives", (fill as { fill?: string }).fill?.length === FILL);

  const queued = first.call({ replies: [200 * KIB, 300 * KIB, 100 * KIB] });
  queued.release();
  check("replies queued before one notify arrive at once, in order", JSON.stringify(lengths(queued.received)) === JSON.stringify([[0, 200 * KIB], [1, 300 * KIB], [2, 100 * KIB]]), lengths(queued.received));

  const sab = new SharedArrayBuffer(16), view = new Int32Array(sab);
  check("timed-out", Atomics.wait(view, 3, 0, 10) === "timed-out");
  view[3] = 5;
  check("not-equal", Atomics.wait(view, 3, 0) === "not-equal");

  const sharing = new Promise<unknown>(resolve => first.worker.once("message", resolve));
  const shareBack = first.call({ replies: [], shareBack: true });
  shareBack.release();
  const shared = await within(sharing, 30000, "shared buffer from the worker").catch(error => String(error));
  const sharedBuffer = (shared as { shared?: SharedArrayBuffer }).shared;
  check("worker posts a SharedArrayBuffer to its parent", sharedBuffer instanceof SharedArrayBuffer && new Int32Array(sharedBuffer)[0] === 73, String(shared));

  const closed = new Promise<void>(resolve => first.mainPort.once("close", resolve));
  const closing = first.call({ replies: [16], closePort: true });
  closing.release();
  check("last reply before the worker closes its port", JSON.stringify(lengths(closing.received)) === JSON.stringify([[0, 16]]), lengths(closing.received));
  check("port close reaches main", await within(closed, 30000, "port close").then(() => true, () => false));
  first.mainPort.postMessage("after close"); // dropped, not thrown
  await first.worker.terminate();
  check("serving worker exit", typeof (await within(first.exit, 30000, "serving worker exit")) === "number");

  // Cancellation: a worker parked in Atomics.wait with its lanes open is terminated.
  const parkedSab = new SharedArrayBuffer(16), parkedView = new Int32Array(parkedSab);
  const { port2: unused } = new MessageChannel();
  const blocked = new Worker(self, { workerData: { port: unused, mode: "block", sab: parkedSab }, transferList: [unused] });
  const started = Atomics.wait(parkedView, 0, 0, 30000);
  check("blocked worker started", started !== "timed-out", started);
  Atomics.wait(parkedView, 3, 0, 200); // let it park
  const terminated = await within(blocked.terminate(), 15000, "terminate of a blocked worker").catch(error => String(error));
  check("terminate cancels a blocked worker with open lanes", typeof terminated === "number", terminated);

  // Settlement: every cycle opens two lanes and a request; exits must return members and regions.
  async function cycle(index: number) {
    const member = service("cycle");
    const failure = new Promise<number>((_, reject) => member.worker.once("error", reject));
    const round = member.call({ replies: [64 * KIB] });
    round.release();
    const got = JSON.stringify(lengths(round.received));
    if (round.status !== "ok" || got !== JSON.stringify([[0, 64 * KIB]])) throw new Error(`cycle reply ${round.status} ${got}`);
    member.mainPort.close();
    await member.worker.terminate();
    await within(Promise.race([member.exit, failure]), 30000, `member ${index}`);
  }
  let cycles = 0;
  for (; cycles < MEMBER_CYCLES; cycles++) {
    const error = await cycle(cycles).then(() => null, (reason: unknown) => String(reason));
    if (error) { check(`member cycle ${cycles}`, false, error); break; }
  }
  check(`${MEMBER_CYCLES} sequential members with lanes settled`, cycles === MEMBER_CYCLES, cycles);

  process.exitCode = failed ? 1 : 0;
}
