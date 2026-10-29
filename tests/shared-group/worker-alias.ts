// Real Bun workers sharing bytes in one memory group (shared-group QuickJS pair only).
// Every checked value travels through shared memory: workers post no data, so a copied or
// serialized buffer cannot pass. A split pair must fail at the first Worker with DataCloneError.
// Usage: bun worker-alias.ts   (prints one PASS line per check, exits 1 on the first failure)
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const HANDSHAKE_TRIES = 20000;
const MEMBER_CYCLES = 20; // more than the group's 16-member cap: exits must settle members

/** Notify until one parked waiter (in another process) is woken; returns the tries used. */
function wakeOne(view: Int32Array, index: number): number {
  for (let tries = 1; tries <= HANDSHAKE_TRIES; tries++) {
    if (Atomics.notify(view, index, 1) === 1) return tries;
    Atomics.wait(view, 63, 0, 1);
  }
  throw new Error(`no waiter parked on word ${index}`);
}

if (!isMainThread) {
  const { sab, mode } = workerData as { sab: SharedArrayBuffer; mode: "alias" | "block" | "cycle" };
  const view = new Int32Array(sab);
  if (mode === "block") {
    Atomics.store(view, 12, 1);
    Atomics.notify(view, 12);
    Atomics.wait(view, 13, 0); // never notified: only termination ends this member
  } else if (mode === "cycle") {
    Atomics.add(view, 15, 1);
  } else {
    // A second buffer arrives over the Worker's message port, not workerData.
    parentPort!.once("message", (message: { second: SharedArrayBuffer }) => {
      const second = new Int32Array(message.second);
      second[0] = 99;
      Atomics.store(second, 2, 1);
      wakeOne(second, 1);
      parentPort!.close();
    });
    parentPort!.postMessage("ready"); // the only message; it carries no checked value
    // Worker -> main: plain store, release flag, then wake main parked on word 0.
    view[1] = 42;
    Atomics.store(view, 6, 1);
    wakeOne(view, 0);
    // Main -> worker: park until main wakes us, then read main's plain store.
    if (Atomics.wait(view, 8, 0, 30000) !== "ok") throw new Error("worker was not woken by main");
    if (Atomics.load(view, 7) !== 1 || view[2] !== 7) throw new Error(`worker read ${view[2]}`);
    view[3] = view[2] * 3;
    Atomics.add(view, 9, 1);
    wakeOne(view, 10);
  }
} else {
  let failed = false;
  const check = (name: string, ok: boolean, detail: unknown = "") => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` ${JSON.stringify(detail)}`}`);
    if (!ok) failed = true;
  };
  const exited = (worker: Worker) => new Promise<number>(resolve => worker.once("exit", resolve));
  const within = <T>(promise: Promise<T>, ms: number, what: string) =>
    Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

  const self = new URL(import.meta.url).pathname;
  const sab = new SharedArrayBuffer(256);
  const view = new Int32Array(sab);
  const worker = new Worker(self, { workerData: { sab, mode: "alias" } });
  const exit = exited(worker);
  await within(new Promise(resolve => worker.once("message", resolve)), 30000, "worker start");

  const woke = Atomics.wait(view, 0, 0, 30000);
  check("worker-to-main wake", woke === "ok", woke);
  check("worker plain store visible in main", Atomics.load(view, 6) === 1 && view[1] === 42, view[1]);

  view[2] = 7;
  Atomics.store(view, 7, 1);
  check("main-to-worker wake", wakeOne(view, 8) >= 1);
  const back = Atomics.wait(view, 10, 0, 30000);
  check("worker read main's store and answered", back === "ok" && Atomics.load(view, 9) === 1 && view[3] === 21, [back, view[3]]);

  const second = new SharedArrayBuffer(16);
  const secondView = new Int32Array(second);
  worker.postMessage({ second });
  const viaPort = Atomics.wait(secondView, 1, 0, 30000);
  check("buffer posted on the port aliases", viaPort === "ok" && Atomics.load(secondView, 2) === 1 && secondView[0] === 99, [viaPort, secondView[0]]);

  check("timed-out", Atomics.wait(view, 11, 0, 10) === "timed-out");
  check("not-equal", Atomics.wait(view, 6, 0) === "not-equal");
  check("alias worker exit", (await within(exit, 30000, "alias worker exit")) === 0);

  // Cancellation: a member parked forever in a group futex wait is terminated.
  const blocked = new Worker(self, { workerData: { sab, mode: "block" } });
  const parked = Atomics.wait(view, 12, 0, 30000);
  check("blocked worker started", parked === "ok" || Atomics.load(view, 12) === 1, parked);
  Atomics.wait(view, 63, 0, 200); // let it park in Atomics.wait
  const terminated = await within(blocked.terminate(), 15000, "terminate of a blocked worker").catch(error => String(error));
  check("terminate cancels a blocked futex wait", typeof terminated === "number", terminated);

  // Settlement: exited members return their group slots, or spawn 17 fails with EAGAIN.
  for (let cycle = 0; cycle < MEMBER_CYCLES; cycle++) {
    let code: unknown;
    try {
      const member = new Worker(self, { workerData: { sab, mode: "cycle" } });
      const failure = new Promise<number>((_, reject) => member.once("error", reject));
      code = await within(Promise.race([exited(member), failure]), 30000, `member ${cycle}`);
    } catch (error) { code = String(error); }
    if (code !== 0) { check(`member cycle ${cycle}`, false, code); break; }
  }
  check(`${MEMBER_CYCLES} sequential members settled`, Atomics.load(view, 15) === MEMBER_CYCLES, Atomics.load(view, 15));
  check("main still owns the buffer", Atomics.add(view, 14, 1) === 0 && view[14] === 1);

  process.exitCode = failed ? 1 : 0;
}
