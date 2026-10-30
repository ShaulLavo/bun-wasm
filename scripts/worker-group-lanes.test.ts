import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { allocate, counters, createGroup, failNextAccept, groupRuntime, LANE_BYTES, startChild, type Member } from "./fixtures/shared-objects/group-runtime";

// SolidStart's esbuild sync API on a memory group (design.md "What the consumers need", item 3):
// main blocks in Atomics.wait, the worker posts its reply on a MessagePort and notifies, and main
// reads the reply with receiveMessageOnPort at once. The control pipes here hold 64 KiB (Waffle's
// default), and the worker stays blocked after notifying, so a reply is complete at wake time only
// if it was in shared memory before the notify. The real threads run the real worker_threads,
// worker_codec, worker_channel, group_shared_objects and shared_lane sources over a fake group.
// Node control of the protocol only: not a Bun or guest qualification.
const PIPE = 1 << 16;
const child = new URL("./fixtures/shared-objects/group-lanes-child.ts", import.meta.url);
// Red controls: BUN_WASM_LANE_SOURCES=<older tree> runs that tree's runtime. Without lanes the root
// holds a request for the worker until the worker's bind reaches it, which a parent blocked in
// Atomics.wait never reads; BUN_WASM_LANE_SETTLE_MS lets the parent's loop run first, so the
// remaining failure is the pipe itself. The real esbuild order (no settling) is the default.
const sources = process.env.BUN_WASM_LANE_SOURCES;
const settleMs = Number(process.env.BUN_WASM_LANE_SETTLE_MS ?? 0);
let running: { parent: Member; close(): Promise<void> } | null = null;
afterEach(async () => { await running?.close(); running = null; });

async function esbuildShape() {
  const group = createGroup([16, 16, 16, 16, 16, 16].concat(Array(6).fill(LANE_BYTES)), PIPE);
  const parent = groupRuntime({ group, pid: 1, sources, spawn: spec => startChild(child, group, spec, { sources }) });
  const { MessageChannel, Worker, receiveMessageOnPort } = parent.threads;
  const { port1: mainPort, port2: workerPort } = new MessageChannel();
  const worker = new Worker("", { eval: true, workerData: { port: workerPort }, transferList: [workerPort] });
  const exited = once(worker, "exit");
  function call(request: Record<string, unknown>, waitMs = 10_000) {
    const sab = allocate(group, 16), view = new Int32Array(sab);
    worker.postMessage({ sab, ...request });
    const status = Atomics.wait(view, 0, 0, waitMs);
    const received: unknown[] = [];
    for (let message = receiveMessageOnPort(mainPort); message; message = receiveMessageOnPort(mainPort)) received.push(message.message);
    return { status, received, view, release() { Atomics.store(view, 1, 1); Atomics.notify(view, 1); } };
  }
  running = { parent, async close() { mainPort.close(); await worker.terminate(); await exited; await new Promise(resolve => setTimeout(resolve, 20)); parent.loop.stop(); } };
  if (settleMs) await new Promise(resolve => setTimeout(resolve, settleMs));
  return { group, worker, mainPort, call, exited };
}
const replies = (received: unknown[]) => received.map(value => { const { index, text } = value as { index: number; text: string }; return [index, text.length]; });

test("a reply larger than the control pipe is complete when the waiter wakes", async () => {
  const { call } = await esbuildShape();
  const reply = call({ replies: [512 * 1024] });
  reply.release();
  expect(512 * 1024).toBeGreaterThan(PIPE);
  expect({ status: reply.status, replies: replies(reply.received) }).toEqual({ status: "ok", replies: [[0, 512 * 1024]] });
});

test("another channel's backlog on the control pipe does not hold the reply back", async () => {
  const { call } = await esbuildShape();
  const reply = call({ fill: 48 * 1024, replies: [32 * 1024] });
  reply.release();
  expect({ status: reply.status, replies: replies(reply.received) }).toEqual({ status: "ok", replies: [[0, 32 * 1024]] });
});

test("replies queued before one notify all arrive at once, in order", async () => {
  const { call } = await esbuildShape();
  const reply = call({ replies: [200 * 1024, 300 * 1024, 100 * 1024] });
  reply.release();
  expect(replies(reply.received)).toEqual([[0, 200 * 1024], [1, 300 * 1024], [2, 100 * 1024]]);
});

test("a reply larger than the lane takes the pipe and keeps its order", async () => {
  const { call, mainPort } = await esbuildShape();
  const reply = call({ replies: [1536 * 1024, 16] });
  // Over the 1 MiB ring the reply cannot be visible at wake (the documented lane limit); the
  // small reply behind it on the lane waits for it rather than overtake it.
  expect({ status: reply.status, replies: replies(reply.received) }).toEqual({ status: "ok", replies: [] });
  reply.release();
  const arrived: unknown[] = [];
  const both = new Promise<void>(resolve => (mainPort as unknown as { on(event: string, listener: (value: unknown) => void): void })
    .on("message", value => { arrived.push(value); if (arrived.length === 2) resolve(); }));
  await both;
  expect(replies(arrived)).toEqual([[0, 1536 * 1024], [1, 16]]);
});

test("a timed-out wait leaves the reply for the next wake", async () => {
  const { group, worker, mainPort } = await esbuildShape();
  const { receiveMessageOnPort } = running!.parent.threads;
  const sab = allocate(group, 16), view = new Int32Array(sab);
  worker.postMessage({ sab, delayMs: 300, replies: [256 * 1024] });
  expect(Atomics.wait(view, 0, 0, 20)).toBe("timed-out");
  expect(receiveMessageOnPort(mainPort)).toBeUndefined();
  expect(Atomics.wait(view, 0, 0, 10_000)).toBe("ok");
  expect(replies([receiveMessageOnPort(mainPort)?.message])).toEqual([[0, 256 * 1024]]);
  Atomics.store(view, 1, 1); Atomics.notify(view, 1);
});

async function until(condition: () => boolean, what: string) {
  for (const deadline = Date.now() + 5000; !condition();) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("messages to a closing or closed worker port give back their pins", async () => {
  const { group, worker, call } = await esbuildShape();
  const closing = call({ closeParent: true });
  expect(closing.status).toBe("ok");
  // The worker's close is still pending (it is blocked): this message is routed to it, then
  // discarded when its port finishes closing, which must unpin it.
  worker.postMessage({ sab: allocate(group, 16) });
  expect(counters(group).pins).toBe(1);
  closing.release();
  await until(() => counters(group).pins === 0, "the discarded message's pin");
  // Now the lane reports the peer closed: nothing is pinned at all.
  worker.postMessage({ sab: allocate(group, 16) });
  expect(counters(group).pins).toBe(0);
});

// A port moved in a packet whose destination never decodes it must be retired at the root: its
// sender already published `moving`, so otherwise the root keeps it ownerless and parks its
// surviving peer's packets (including that peer's close) forever.
async function retired(parent: Member, before: string[], what: string) {
  await until(() => parent.routes().owners.every(id => before.includes(id)) && !parent.routes().pending.length, what);
  return parent.routes();
}

test("a port moved to a destination that closes during delivery is retired at the root", async () => {
  const { mainPort, call } = await esbuildShape();
  const parent = running!.parent;
  const closing = call({ replies: [], closePort: true });
  expect(closing.status).toBe("ok");
  const before = parent.routes().owners;
  const { port1: moved, port2: survivor } = new parent.threads.MessageChannel();
  // The worker's port is closing but the worker is blocked: this packet (it carries a port, so
  // it takes the control pipe) reaches a port that never reads it.
  mainPort.postMessage({ moved }, [moved]);
  closing.release();
  survivor.close();
  const routes = await retired(parent, before, "the moved port's retirement");
  expect(routes.pending).toEqual([]);
});

test("a port moved in a packet that fails to decode is retired and its pins released", async () => {
  const { group, worker, call } = await esbuildShape();
  const parent = running!.parent;
  // One answered call first: the worker has decoded its own startup buffers.
  call({ replies: [] }).release();
  const before = parent.routes().owners;
  const { port1: moved, port2: survivor } = new parent.threads.MessageChannel();
  failNextAccept(group, 2);
  // The receipt of `sab` fails in the worker after the parent published `moved`'s move.
  worker.postMessage({ sab: allocate(group, 16), moved }, [moved]);
  await until(() => counters(group).pins === 0, "the failed packet's pin");
  survivor.close();
  const routes = await retired(parent, before, "the moved port's retirement");
  expect(routes.pending).toEqual([]);
});

test("a worker posts a SharedArrayBuffer to its parent over parentPort", async () => {
  const { worker, call } = await esbuildShape();
  const message = once(worker, "message");
  const reply = call({ shareBack: true });
  reply.release();
  const [{ shared }] = await message as [{ shared: SharedArrayBuffer }];
  expect(new Int32Array(shared)[0]).toBe(73);
});

test("terminating the worker leaves no pins or lane watches behind", async () => {
  const { group, call } = await esbuildShape();
  const reply = call({ replies: [64] });
  reply.release();
  expect(counters(group).watches).toBeGreaterThan(0);
  await running!.close(); running = null;
  expect(counters(group)).toEqual({ pins: 0, watches: 0 });
});
