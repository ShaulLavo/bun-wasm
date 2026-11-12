// Component control for shared-group lanes: the real worker_threads, worker_codec and
// worker_channel sources, two or three source runtimes standing in for guests, and real Waffle
// pipes wired as spawn wires them, so the pipe to each child is in relay mode and its relay is
// never serviced. The lane provider is the topology model in fixtures/shared-objects/group-lanes.ts;
// lane.rs's own unit tests cover the Rust algorithm.
import { afterEach, expect, test } from "bun:test";
import { PipeController, type PipeEndpoint } from "../node_modules/waffle/proc/pipes.ts";
import { createGroupLaneModel, groupSharedObjects } from "./fixtures/shared-objects/group-lanes";
import { sourceChannel, sourcePorts, type SourcePort } from "./fixtures/shared-objects/source-runtime";

const AGAIN = -6;
const cleanup = new Set<() => void>();
afterEach(() => { for (const close of cleanup) close(); cleanup.clear(); pipeFault.next = null; });

type Trace = { from: string; text: string }[];
/** Makes the next control-pipe write of any guest fail before it ran, or after it ran and before its reply. */
const pipeFault: { next: "before" | "after" | null } = { next: null };
function host(input: PipeEndpoint, output: PipeEndpoint, from: string, trace: Trace) {
  let last: [token: number, result: number] = [0, 0];
  return {
    procRead() {
      const buffer = new Uint8Array(65536);
      const read = input.tryRead([buffer]);
      return read > 0 ? buffer.slice(0, read) : read;
    },
    procWriteOnce(_fd: number, bytes: Uint8Array, token: number) {
      const failing = pipeFault.next;
      pipeFault.next = null;
      if (failing === "before") throw new Error("core data allocation failed");
      trace.push({ from, text: Buffer.from(bytes).toString("utf8") });
      last = [token, output.tryWrite([bytes])];
      if (failing === "after") throw new Error("core data allocation failed");
      return last[1];
    },
    procWriteResult: (token: number) => last[0] === token ? last[1] : -(2 ** 63),
    procPoll: () => new Uint8Array(0),
    procClose() {},
  };
}

/**
 * Pipes as spawn creates them: the child's reader is retained before the parent's closes, so
 * the pipe to the child relays and its relay is never serviced. `direct` keeps one reader, for
 * cases about what the parent sends the child rather than about lane visibility.
 */
function spawnPipes(pid: number, trace: Trace, direct = false) {
  const down = new PipeController({ capacity: 65536, relay: "manual" });
  const parentWrite = down.retain(1, "write");
  const original = direct ? undefined : down.retain(1, "read");
  const childRead = down.retain(pid, "read");
  original?.close();
  const up = new PipeController({ capacity: 65536 });
  const childWrite = up.retain(pid, "write");
  const parentRead = up.retain(1, "read");
  cleanup.add(() => { for (const end of [parentWrite, childRead, childWrite, parentRead]) end.close(); down.dispose?.(); up.dispose?.(); });
  return {
    parentWrite, childRead,
    parent: sourceChannel(host(parentRead, parentWrite, `parent to ${pid}`, trace)),
    child: sourceChannel(host(childRead, childWrite, `child ${pid}`, trace)),
  };
}

type Runtime = ReturnType<typeof sourcePorts>;
function group(options: { beforeDetach?: () => void } = {}) {
  const model = createGroupLaneModel();
  const trace: Trace = [];
  const rootLanes = model.member(1);
  const root = sourcePorts({ sharedObjects: groupSharedObjects(rootLanes), beforeDetach: options.beforeDetach });
  cleanup.add(() => root.__fixtureShutdown());
  let next = 2;
  /** Starts a child whose workerData is `data`, carrying `transfer` and its parent port. */
  function spawn(data: unknown = null, transfer: unknown[] = [], direct = false) {
    const pid = next++;
    const id = pid - 2;
    const pipes = spawnPipes(pid, trace, direct);
    const lanes = model.member(pid);
    const { port1, port2 } = new root.MessageChannel();
    const cell = rootLanes.cell();
    const plan = root.codec.prepare([data, [], port2], transfer.concat([port2]), [], { kind: "cell", cell });
    plan.commit();
    root.__fixtureChild(pipes.parent, plan.graph, id);
    const child: Runtime = sourcePorts({ sharedObjects: groupSharedObjects(lanes), channel: pipes.child, graph: plan.graph, route: [id], lanes: { ledger: 4096, cell } });
    cleanup.add(() => child.__fixtureShutdown());
    child.initialize();
    return { child, port: port1, pipes, cell, pid };
  }
  return { model, trace, root, rootLanes, spawn };
}

function carried(value: unknown): SourcePort {
  const port = value && typeof value === "object" && "port" in value ? value.port : null;
  if (!isPort(port)) throw new Error("Missing carried port");
  return port;
}
function isPort(value: unknown): value is SourcePort {
  return typeof value === "object" && value !== null && "postMessage" in value && "close" in value;
}
function payload(bytes: number) {
  return { task: "x".repeat(bytes), filename: "/control/attribute.mjs", flag: true, missing: undefined };
}

test("the child's pipe is in relay mode and its relay is never serviced", () => {
  const { spawn } = group();
  const { pipes } = spawn();
  expect(pipes.parentWrite.tryWrite([new TextEncoder().encode("control\n")])).toBe(8);
  expect(pipes.childRead.tryRead([new Uint8Array(64)])).toBe(AGAIN);
});

for (const [name, bytes] of [["an 818-byte", 818], ["a 197,589-byte", 197_589]] as const) {
  test(`${name} task is whole at the child's first receive with no pipe data`, () => {
    const { trace, spawn } = group();
    const { child, port } = spawn();
    const buffer = new Uint8Array(64).fill(7).buffer;
    const value = { ...payload(bytes), buffer };
    port.postMessage(value, [buffer]);
    expect(buffer.byteLength).toBe(0);
    const received = child.receiveMessageOnPort(child.parentPort);
    expect(received?.message).toEqual({ ...payload(bytes), buffer: new Uint8Array(64).fill(7).buffer });
    expect(trace.some(item => item.text.includes("port-data"))).toBe(false);
  });
}

test("a sender that stops right after posting changes nothing for the receiver", () => {
  const { spawn } = group();
  const { child, port, pipes } = spawn();
  port.postMessage("last words");
  pipes.parentWrite.close();
  port.close();
  expect(child.receiveMessageOnPort(child.parentPort)?.message).toBe("last words");
  expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
});

test("siblings exchange messages and ports with the root's pump never called", () => {
  const { root, spawn } = group();
  const { port1, port2 } = new root.MessageChannel();
  const first = spawn({ port: port1 }, [port1]);
  const second = spawn({ port: port2 }, [port2]);
  const sender = carried(first.child.workerData);
  const receiver = carried(second.child.workerData);
  const extra = new first.child.MessageChannel();
  sender.postMessage({ hello: "sibling", reply: extra.port2 }, [extra.port2]);
  const message = second.child.receiveMessageOnPort(receiver)?.message as { hello: string; reply: SourcePort };
  expect(message.hello).toBe("sibling");
  message.reply.postMessage("through the carried port");
  expect(first.child.receiveMessageOnPort(extra.port1)?.message).toBe("through the carried port");
});

test("a message carrying two ports decodes at the first receive and both ports then work", () => {
  const { root, spawn } = group();
  const { child, port } = spawn();
  const one = new root.MessageChannel(), two = new root.MessageChannel();
  port.postMessage({ ports: [one.port2, two.port2] }, [one.port2, two.port2]);
  const message = child.receiveMessageOnPort(child.parentPort)?.message as { ports: [SourcePort, SourcePort] };
  expect(message.ports).toHaveLength(2);
  one.port1.postMessage("first");
  two.port1.postMessage("second");
  expect(child.receiveMessageOnPort(message.ports[0])?.message).toBe("first");
  expect(child.receiveMessageOnPort(message.ports[1])?.message).toBe("second");
  message.ports[1].postMessage("back");
  expect(root.receiveMessageOnPort(two.port1)?.message).toBe("back");
});

test("a refused lane reservation throws DataCloneError before anything detaches", () => {
  const { model, spawn } = group();
  const { child, port } = spawn();
  const buffer = new ArrayBuffer(32);
  model.control.refuse = true;
  expect(() => port.postMessage({ buffer }, [buffer])).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  expect(buffer.byteLength).toBe(32);
  model.control.refuse = false;
  port.postMessage({ buffer }, [buffer]);
  expect(buffer.byteLength).toBe(0);
  const received = child.receiveMessageOnPort(child.parentPort);
  expect(received?.message).toEqual({ buffer: new ArrayBuffer(32) });
});

for (const when of ["before", "after"] as const) {
  test(`a reservation that fails ${when} the core staged it moves nothing and leaves no gap`, () => {
    const { model, root, spawn } = group();
    const { child, port } = spawn();
    const extra = new root.MessageChannel();
    const buffer = new ArrayBuffer(32);
    port.postMessage("first");
    model.control.fault = { native: "laneReserve", when };
    expect(() => port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2])).toThrow(expect.objectContaining({ name: "DataCloneError" }));
    expect(model.control.fault).toBeNull();
    // The buffer is attached, the port is still this thread's and no frame is staged.
    expect(buffer.byteLength).toBe(32);
    expect(model.control.staged).toBe(0);
    extra.port2.postMessage("still here");
    expect(root.receiveMessageOnPort(extra.port1)?.message).toBe("still here");
    port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2]);
    expect(buffer.byteLength).toBe(0);
    // A failed post that had counted itself would leave the receiver waiting for its sequence.
    expect(child.receiveMessageOnPort(child.parentPort)?.message).toBe("first");
    const second = child.receiveMessageOnPort(child.parentPort)?.message as { buffer: ArrayBuffer; port: SourcePort };
    expect(second.buffer).toEqual(new ArrayBuffer(32));
    second.port.postMessage("carried");
    expect(root.receiveMessageOnPort(extra.port1)?.message).toBe("carried");
    expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
  });

  test(`a receive whose drain fails ${when} the core read the lane loses and repeats nothing`, () => {
    const { model, spawn } = group();
    const { child, port } = spawn();
    for (const value of [1, 2, 3]) port.postMessage(value);
    model.control.fault = { native: "laneDrain", when };
    expect(() => child.receiveMessageOnPort(child.parentPort)).toThrow("core data allocation failed");
    expect(model.control.fault).toBeNull();
    const got: unknown[] = [];
    for (let item = child.receiveMessageOnPort(child.parentPort); item; item = child.receiveMessageOnPort(child.parentPort)) got.push(item.message);
    expect(got).toEqual([1, 2, 3]);
    expect(model.control.drained).toBe(3);
  });
}

test("a port holding frames it read and never took cannot move until it takes them", () => {
  const { model, root, spawn } = group();
  const pair = new root.MessageChannel();
  const first = spawn({ port: pair.port1 }, [pair.port1]);
  const second = spawn({ port: pair.port2 }, [pair.port2]);
  const sender = carried(first.child.workerData);
  const receiver = carried(second.child.workerData);
  sender.postMessage("kept");
  const prepared = second.child.codec.prepare({ port: receiver }, [receiver]);
  model.control.fault = { native: "laneDrain", when: "after" };
  expect(() => second.child.receiveMessageOnPort(receiver)).toThrow("core data allocation failed");
  // The frame is in neither the lane nor the port, so the port's next owner would never see it.
  // A transfer prepared earlier stops at its last check before detachment; a new one is refused.
  expect(() => prepared.commit()).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  expect(() => second.child.parentPort.postMessage({ port: receiver }, [receiver])).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  expect(second.child.receiveMessageOnPort(receiver)?.message).toBe("kept");
  second.child.parentPort.postMessage({ port: receiver }, [receiver]);
  const moved = root.receiveMessageOnPort(second.port)?.message as { port: SourcePort };
  sender.postMessage("after the move");
  expect(root.receiveMessageOnPort(moved.port)?.message).toBe("after the move");
});

test("between detachment and its return, postMessage calls only natives that cannot fail", () => {
  let detached = -1;
  const made = group({ beforeDetach: () => { detached = made.model.control.calls.length; } });
  const { child, port } = made.spawn();
  const extra = new made.root.MessageChannel();
  const buffer = new ArrayBuffer(32);
  port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2]);
  const after = made.model.control.calls.slice(detached);
  // The carried end goes in flight and the frame is published: two word natives. A reserve,
  // a drain or a refusal lookup here would be a call that can throw after detachment.
  expect(detached).toBeGreaterThan(0);
  expect(after).toEqual(["laneTransfer", "laneCommit"]);
  expect(child.receiveMessageOnPort(child.parentPort)?.message).toMatchObject({ buffer: new ArrayBuffer(32) });
});

for (const when of ["before", "after"] as const) {
  test(`a worker's post is whole and returns when its control pipe write fails ${when} it ran`, () => {
    const { root, trace, spawn } = group();
    const { child, port, pid } = spawn();
    const extra = new child.MessageChannel();
    const buffer = new ArrayBuffer(32);
    // The first write after detachment carries the broker's record that the port is moving.
    pipeFault.next = when;
    expect(() => child.parentPort.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2])).not.toThrow();
    expect(pipeFault.next).toBeNull();
    expect(buffer.byteLength).toBe(0);
    const message = root.receiveMessageOnPort(port)?.message as { buffer: ArrayBuffer; port: SourcePort };
    expect(message.buffer).toEqual(new ArrayBuffer(32));
    // The record goes out once: with the post, or at the child's next step if that write never ran.
    child.step();
    const records = trace.filter(item => item.from === `child ${pid}`).map(item => item.text.split('"moving"').length - 1);
    expect(records.reduce((sum, count) => sum + count, 0)).toBe(1);
    root.step();
    message.port.postMessage("to the worker");
    expect(child.receiveMessageOnPort(extra.port1)?.message).toBe("to the worker");
  });
}

test("a closed peer's committed messages arrive in order and then the port closes", async () => {
  const { spawn } = group();
  const { child, port } = spawn();
  let closed = false;
  child.parentPort.on("close", () => { closed = true; });
  for (const value of [1, 2, 3]) port.postMessage(value);
  port.close();
  await new Promise(resolve => setImmediate(resolve));
  const got: unknown[] = [];
  for (let item = child.receiveMessageOnPort(child.parentPort); item; item = child.receiveMessageOnPort(child.parentPort)) got.push(item.message);
  expect(got).toEqual([1, 2, 3]);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(true);
});

test("ports carried in unread frames close when the reader closes", async () => {
  const { root, spawn } = group();
  const { child, port } = spawn();
  const carried = new root.MessageChannel();
  let closed = false;
  carried.port1.on("close", () => { closed = true; });
  port.postMessage({ port: carried.port2 }, [carried.port2]);
  child.parentPort.close();
  // The carrying frame is never parsed: the ledger closes the carried end and its peer sees it.
  root.pump();
  expect(root.receiveMessageOnPort(carried.port1)).toBeUndefined();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(true);
  port.postMessage("discarded after the reader closed");
});

test("a worker exit closes its ends and the parent's port sees the lane end", async () => {
  const { root, rootLanes, spawn } = group();
  const { port, cell } = spawn();
  let closed = false;
  port.on("close", () => { closed = true; });
  rootLanes.exited(cell);
  root.pump();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(true);
});

/**
 * A port carried to a receiver that never reads it, whose peer lives in a third guest that is
 * idle: nothing reaches that peer except what the root sends after it retires the record.
 */
async function carriedToIdlePeer(finish: (receiver: ReturnType<ReturnType<typeof group>["spawn"]>, lanes: BunWasm.GroupLanes, model: ReturnType<typeof group>["model"]) => void) {
  const { model, root, rootLanes, trace, spawn } = group();
  const pair = new root.MessageChannel();
  const holder = spawn({ port: pair.port1 }, [pair.port1], true);
  const receiver = spawn();
  const peer = carried(holder.child.workerData);
  let closed = false;
  peer.on("close", () => { closed = true; });
  // The root learns the holder's bind and the carried port's move.
  root.step();
  receiver.port.postMessage({ port: pair.port2 }, [pair.port2]);
  const records = root.__fixtureOwners().length;
  finish(receiver, rootLanes, model);
  const toHolder = () => trace.filter(item => item.from === `parent to ${holder.pid}` && item.text.includes("port-close"));
  expect(toHolder()).toHaveLength(0);
  // An ordinary step: the sweep, then the retirement of records whose lane end closed.
  root.step();
  expect(toHolder().length).toBeGreaterThan(0);
  expect(root.__fixtureOwners().length).toBeLessThan(records);
  // The frame on its pipe is what wakes the idle holder; its next step closes the port.
  holder.child.step();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(true);
}

test("the root retires a carried port whose receiver died unread and closes its idle peer", async () => {
  await carriedToIdlePeer((receiver, lanes) => lanes.exited(receiver.cell));
});

test("the root retires a carried port whose receiver closed unread and closes its idle peer", async () => {
  await carriedToIdlePeer(receiver => receiver.child.parentPort.close());
});

test("the root retires a carried port closed by a member that died without another word", async () => {
  // Another member closes the carried end and stops there: it sends nothing and writes nothing
  // but the end words. Those are what the root reads at its next step.
  await carriedToIdlePeer((receiver, _lanes, model) => {
    const finalizer = model.member(99);
    finalizer.ledger();
    finalizer.exited(receiver.cell);
  });
});

test("a rescan keeps ports that are open or still in flight", () => {
  const { root, rootLanes, trace, spawn } = group();
  const pair = new root.MessageChannel();
  const holder = spawn({ port: pair.port1 }, [pair.port1], true);
  const receiver = spawn();
  const peer = carried(holder.child.workerData);
  root.step();
  receiver.port.postMessage({ port: pair.port2 }, [pair.port2]);
  // An unrelated worker exits, so the root rescans while pair.port2 is in flight.
  const third = spawn();
  rootLanes.exited(third.cell);
  root.step();
  expect(trace.some(item => item.from === `parent to ${holder.pid}` && item.text.includes("port-close"))).toBe(false);
  // The receiver restores the in-flight port and it still reaches the holder.
  const message = receiver.child.receiveMessageOnPort(receiver.child.parentPort)?.message as { port: SourcePort };
  message.port.postMessage("after the rescan");
  expect(holder.child.receiveMessageOnPort(peer)?.message).toBe("after the rescan");
});

test("a synchronous receive never sweeps; the next ordinary step does", () => {
  const { model, root, spawn } = group();
  const { child, port, pipes, pid } = spawn(null, [], true);
  const full = (tag: number) => model.control.sweeps.filter(item => item.tag === tag && item.full).length;
  // The parent's channel ends while the child is inside receiveMessageOnPort.
  pipes.parentWrite.close();
  port.postMessage("still here");
  expect(child.receiveMessageOnPort(child.parentPort)?.message).toBe("still here");
  expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
  expect(full(pid)).toBe(0);
  child.step();
  expect(full(pid)).toBe(1);
  // A gone frame handled inside the root's receive also waits for the root's step.
  pipes.child.send({ kind: "up", body: { kind: "gone", path: [9] } });
  expect(root.receiveMessageOnPort(port)).toBeUndefined();
  expect(full(1)).toBe(0);
  root.step();
  expect(full(1)).toBe(1);
});
