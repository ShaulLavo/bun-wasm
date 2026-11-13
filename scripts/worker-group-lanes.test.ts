// Component control for shared-group lanes: the real worker_threads, worker_codec and
// worker_channel sources, two or three source runtimes standing in for guests, and real Waffle
// pipes wired as spawn wires them, so the pipe to each child is in relay mode and its relay is
// never serviced. The lane provider is the topology model in fixtures/shared-objects/group-lanes.ts;
// lane.rs's own unit tests cover the Rust algorithm.
import { afterEach, expect, test } from "bun:test";
import { PipeController, type PipeEndpoint } from "../node_modules/waffle/proc/pipes.ts";
import { createGroupLaneModel, groupSharedObjects } from "./fixtures/shared-objects/group-lanes";
import { sourceChannels, sourcePorts, type SourcePort, type TransferHooks } from "./fixtures/shared-objects/source-runtime";

const AGAIN = -6;
const cleanup = new Set<() => void>();
afterEach(() => { for (const close of cleanup) close(); cleanup.clear(); pipeFault.next = null; });

type Trace = { from: string; text: string }[];
/** Makes the next control-pipe write of any guest fail before it ran, or after it ran and before its reply. */
const pipeFault: { next: "before" | "after" | null } = { next: null };
/**
 * One guest's pipe natives, as its core has them: every control channel the guest opens writes
 * through the same natives by descriptor, the channels share one worker_channel module, and the
 * core keeps a single last write attempt for the whole guest.
 */
function guestPipes(trace: Trace) {
  const ends = new Map<number, { endpoint: PipeEndpoint; from: string }>();
  let last = { fd: 0, token: 0, result: 0 };
  let nextFd = 3;
  const end = (fd: number) => {
    const found = ends.get(fd);
    if (!found) throw new Error(`Unknown descriptor ${fd}`);
    return found;
  };
  const channels = sourceChannels({
    procRead(fd: number) {
      const buffer = new Uint8Array(65536);
      const read = end(fd).endpoint.tryRead([buffer]);
      return read > 0 ? buffer.slice(0, read) : read;
    },
    procWriteOnce(fd: number, bytes: Uint8Array, token: number) {
      const failing = pipeFault.next;
      pipeFault.next = null;
      if (failing === "before") throw new Error("core data allocation failed");
      trace.push({ from: end(fd).from, text: Buffer.from(bytes).toString("utf8") });
      last = { fd, token, result: end(fd).endpoint.tryWrite([bytes]) };
      if (failing === "after") throw new Error("core data allocation failed");
      return last.result;
    },
    procWriteResult: (fd: number, high: number, low: number) => last.fd === fd && last.token === high * 2 ** 32 + low ? last.result : -(2 ** 63),
    procPoll: () => new Uint8Array(0),
    procClose() {},
  });
  /** Opens one of this guest's channels over a pipe pair; `from` labels what it writes in the trace. */
  return function open(input: PipeEndpoint, output: PipeEndpoint, from: string) {
    const [inputFd, outputFd] = [nextFd++, nextFd++];
    ends.set(inputFd, { endpoint: input, from });
    ends.set(outputFd, { endpoint: output, from });
    return channels.open(inputFd, outputFd);
  };
}

/**
 * Pipes as spawn creates them: the child's reader is retained before the parent's closes, so
 * the pipe to the child relays and its relay is never serviced. `direct` keeps one reader, for
 * cases about what the parent sends the child rather than about lane visibility.
 */
function spawnPipes(pid: number, trace: Trace, direct: boolean, parentOpen: ReturnType<typeof guestPipes>) {
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
    parent: parentOpen(parentRead, parentWrite, `parent to ${pid}`),
    child: guestPipes(trace)(childRead, childWrite, `child ${pid}`),
  };
}

type Runtime = ReturnType<typeof sourcePorts>;
/** `realLoop` gives every guest the runtime's own I/O loop (net.js) in place of a bare waiter. */
function group(options: { realLoop?: boolean; child?: TransferHooks } & TransferHooks = {}) {
  const model = createGroupLaneModel();
  const trace: Trace = [];
  const rootLanes = model.member(1);
  const root = sourcePorts({ sharedObjects: groupSharedObjects(rootLanes), core: rootLanes.natives, beforeTransfer: options.beforeTransfer, beforeDetach: options.beforeDetach, settled: options.settled, realLoop: options.realLoop });
  cleanup.add(() => root.__fixtureShutdown());
  const rootOpen = guestPipes(trace);
  let next = 2;
  /** Starts a child whose workerData is `data`, carrying `transfer` and its parent port. */
  function spawn(data: unknown = null, transfer: unknown[] = [], direct = false) {
    const pid = next++;
    const id = pid - 2;
    const pipes = spawnPipes(pid, trace, direct, rootOpen);
    const lanes = model.member(pid);
    const { port1, port2 } = new root.MessageChannel();
    const cell = rootLanes.cell();
    const plan = root.codec.prepare([data, [], port2], transfer.concat([port2]), [], { kind: "cell", cell });
    plan.commit();
    root.__fixtureChild(pipes.parent, plan.graph, id);
    const child: Runtime = sourcePorts({ ...options.child, sharedObjects: groupSharedObjects(lanes), core: lanes.natives, channel: pipes.child, graph: plan.graph, route: [id], lanes: { ledger: 4096, cell }, realLoop: options.realLoop });
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

test("a post commits in the transfer native, and nothing runs between its detach and its return", () => {
  let detached = -1, settled = 0;
  const made = group({ beforeDetach: () => { detached = made.model.control.calls.length; }, settled: () => { settled++; } });
  const { child, port } = made.spawn();
  const extra = new made.root.MessageChannel();
  const buffer = new ArrayBuffer(32);
  const calls = made.model.control.calls;
  port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2]);
  // The last native before the detach is the commit check, the last call that can refuse. After
  // it only the native's own commit runs: the runtime calls nothing until it is entered again.
  expect(detached).toBeGreaterThan(0);
  expect(calls[detached - 1]).toBe("laneCommitCheck");
  expect(calls.slice(detached)).toEqual(["laneCommitStaged"]);
  expect(settled).toBe(0);
  expect(buffer.byteLength).toBe(0);
  // The receiver needs nothing more from the sender: the message is whole and its port works.
  const message = child.receiveMessageOnPort(child.parentPort)?.message as { buffer: ArrayBuffer; port: SourcePort };
  expect(message.buffer).toEqual(new ArrayBuffer(32));
  message.port.postMessage("carried");
  expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("carried");
  // The sender's next entry finishes what the post owed and releases what the native held.
  expect(settled).toBe(1);
  expect(made.model.control.staged).toBe(0);
});

for (const when of ["before", "after"] as const) {
  test(`a worker's post writes nothing to its pipe, and the record it owes goes out once when that write fails ${when} it ran`, () => {
    const { root, trace, spawn } = group();
    const { child, port, pid } = spawn();
    const extra = new child.MessageChannel();
    const buffer = new ArrayBuffer(32);
    const records = () => trace.filter(item => item.from === `child ${pid}`).reduce((sum, item) => sum + item.text.split('"moving"').length - 1, 0);
    pipeFault.next = when;
    expect(() => child.parentPort.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2])).not.toThrow();
    // The post ended with the call that committed it: the record that the port is moving is owed.
    expect(pipeFault.next).toBe(when);
    expect(records()).toBe(0);
    expect(buffer.byteLength).toBe(0);
    const message = root.receiveMessageOnPort(port)?.message as { buffer: ArrayBuffer; port: SourcePort };
    expect(message.buffer).toEqual(new ArrayBuffer(32));
    // The child's next steps send it, once, whichever way its first write failed.
    child.step();
    expect(pipeFault.next).toBeNull();
    child.step();
    expect(records()).toBe(1);
    root.step();
    message.port.postMessage("to the worker");
    expect(child.receiveMessageOnPort(extra.port1)?.message).toBe("to the worker");
  });
}

/** What a failed post must leave: the buffers attached, the carried port usable here, nothing staged, no sequence taken. */
function expectNothingMoved(made: ReturnType<typeof group>, spawned: ReturnType<ReturnType<typeof group>["spawn"]>, extra: { port1: SourcePort; port2: SourcePort }, buffer: ArrayBuffer) {
  expect(buffer.byteLength).toBe(32);
  extra.port2.postMessage("still here");
  expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("still here");
  expect(made.model.control.staged).toBe(0);
  expect(spawned.child.receiveMessageOnPort(spawned.child.parentPort)).toBeUndefined();
  // The next post takes the sequence the failed one would have had, so the receiver sees no gap.
  spawned.port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2]);
  expect(buffer.byteLength).toBe(0);
  const message = spawned.child.receiveMessageOnPort(spawned.child.parentPort)?.message as { buffer: ArrayBuffer; port: SourcePort };
  expect(message.buffer).toEqual(new ArrayBuffer(32));
  message.port.postMessage("carried");
  expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("carried");
}

/** A post of a buffer and a referenced port whose transfer call the engine refused to enter. */
function postRefusedOnEntry() {
  const failure = new RangeError("Maximum call stack size exceeded");
  let fail = true;
  const made = group({ beforeTransfer: () => { if (fail) { fail = false; throw failure; } } });
  const spawned = made.spawn();
  const extra = new made.root.MessageChannel();
  const buffer = new ArrayBuffer(32);
  extra.port2.ref();
  expect(() => spawned.port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2])).toThrow(failure);
  return { made, spawned, extra, buffer };
}

// The ledger keeps a lane, or an end taken from it, whether or not the thread that asked can
// then remember it. Found on a real guest: with its heap full, a post that carried a port made
// the port's lane and then failed to make the lane's two ends, and after 512 such posts no port
// in the group could be sent ("MessagePort lane ledger is full").
for (const failing of [1, 2]) {
  test(`a lane whose ${failing === 1 ? "first" : "second"} end cannot be opened is never made, and its channel is whole for the next post`, () => {
    const made = group();
    const spawned = made.spawn();
    const extra = new made.root.MessageChannel();
    const lanes = made.model.lanes.length;
    const open = made.rootLanes.open, failure = new RangeError("out of memory");
    let opened = 0;
    made.rootLanes.open = (ref, side) => {
      if (++opened === failing) throw failure;
      return open(ref, side);
    };
    try { expect(() => spawned.port.postMessage({ port: extra.port2 }, [extra.port2])).toThrow(failure); }
    finally { made.rootLanes.open = open; }
    // No lane exists that no port refers to.
    expect(made.model.lanes.length).toBe(lanes);
    expect(made.model.control.staged).toBe(0);
    // Still one channel with two local ends, which then moves and carries a message each way.
    extra.port2.postMessage("local");
    expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("local");
    spawned.port.postMessage({ port: extra.port2 }, [extra.port2]);
    expect(made.model.lanes.length).toBe(lanes + 1);
    const moved = carried(spawned.child.receiveMessageOnPort(spawned.child.parentPort)?.message);
    moved.postMessage("from the child"); extra.port1.postMessage("to the child");
    expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("from the child");
    expect(spawned.child.receiveMessageOnPort(moved)?.message).toBe("to the child");
  });
}

test("a transfer call that throws on entry has moved nothing, and the port it carried is whole again", () => {
  const { made, spawned, extra, buffer } = postRefusedOnEntry();
  // The call never ran, so nothing could undo the local steps taken before it. The next entry
  // into the runtime does, before it does anything else.
  expect(extra.port2.hasRef()).toBe(true);
  expectNothingMoved(made, spawned, extra, buffer);
});

for (const recoverInCatch of [false, true]) {
  test(`a port that fails to send itself from its own message handler keeps delivering${recoverInCatch ? " when the handler touches it again" : " with no further call from the program"}`, async () => {
    const failure = new RangeError("Maximum call stack size exceeded");
    let fail = false;
    const made = group({ beforeTransfer: () => { if (fail) { fail = false; throw failure; } } });
    const { child, port: sender } = made.spawn();
    const { port1, port2 } = new made.root.MessageChannel();
    const turn = () => new Promise<void>(resolve => setImmediate(resolve));
    const delivered: unknown[] = [];
    let caught: unknown;
    port2.on("message", value => {
      delivered.push(value);
      if (value !== "first") return;
      fail = true;
      // The transfer call throws on entry, after the port's state was taken off it and while
      // this handler's batch still has "second" to deliver.
      try { sender.postMessage({ port: port2 }, [port2]); }
      catch (error) { caught = error; if (recoverInCatch) port2.hasRef(); }
    });
    port1.postMessage("first"); port1.postMessage("second");
    await turn(); await turn();
    expect(caught).toBe(failure);
    // Only the loop runs from here: its step rolls the post back, and delivery goes on.
    made.root.step();
    await turn(); await turn();
    expect(delivered).toEqual(["first", "second"]);
    port1.postMessage("third");
    await turn(); await turn();
    // In order, once each, and nothing was left for a synchronous receive to find.
    expect(delivered).toEqual(["first", "second", "third"]);
    expect(made.root.receiveMessageOnPort(port2)).toBeUndefined();
    expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
    expect(made.model.control.staged).toBe(0);
    expect(port2.hasRef()).toBe(true);
  });
}

/**
 * A port whose handler for "first" failed to send the port itself, with "second" still queued:
 * the rollback has to queue the delivery of "second" again. `timers` are the runtime's, so a
 * case can make the call that queues a delivery fail.
 */
function selfTransferRefused() {
  const failure = new RangeError("Maximum call stack size exceeded");
  let fail = false;
  const made = group({ beforeTransfer: () => { if (fail) { fail = false; throw failure; } } });
  const { port: sender } = made.spawn();
  const { port1, port2 } = new made.root.MessageChannel();
  const delivered: unknown[] = [];
  port2.on("message", value => {
    delivered.push(value);
    if (value !== "first") return;
    fail = true;
    try { sender.postMessage({ port: port2 }, [port2]); } catch { /* the case checks what follows */ }
  });
  const timers: { setImmediate(callback: () => void): unknown } = made.root.internal.realTimers;
  return { made, port1, port2, delivered, timers };
}
const loopTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test("a rollback that cannot queue the delivery it resumes still owes it, and the loop queues it", async () => {
  const { made, port1, port2, delivered, timers } = selfTransferRefused();
  port1.postMessage("first"); port1.postMessage("second");
  await loopTurn(); await loopTurn();
  expect(delivered).toEqual(["first"]);
  // The engine refuses the call that would queue the callback: nothing is queued.
  const queue = timers.setImmediate;
  let refused = 0;
  timers.setImmediate = () => { timers.setImmediate = queue; refused++; throw new RangeError("Maximum call stack size exceeded"); };
  // Only the loop runs from here. No port method is called and no further message arrives.
  made.root.step();
  expect(refused).toBe(1);
  made.root.step();
  await loopTurn(); await loopTurn();
  expect(delivered).toEqual(["first", "second"]);
  port1.postMessage("third");
  await loopTurn(); await loopTurn();
  expect(delivered).toEqual(["first", "second", "third"]);
  expect(made.root.receiveMessageOnPort(port2)).toBeUndefined();
});

test("a delivery callback queued by a call that then failed is overtaken by the retry and delivers nothing twice", async () => {
  const { made, port1, port2, delivered, timers } = selfTransferRefused();
  port1.postMessage("first"); port1.postMessage("second"); port1.postMessage("third");
  await loopTurn(); await loopTurn();
  // Every callback queued from here on is counted, with how many messages it delivered.
  const queue = timers.setImmediate;
  const work: number[] = [];
  const counted = (callback: () => void) => queue(() => {
    const before = delivered.length;
    callback();
    work.push(delivered.length - before);
  });
  // The first call queues its callback and then fails, as when the wake after it cannot be made.
  timers.setImmediate = callback => { timers.setImmediate = counted; counted(callback); throw new RangeError("Maximum call stack size exceeded"); };
  // Two steps before any callback runs: the second retries the rollback and queues another.
  made.root.step(); made.root.step();
  for (let turn = 0; turn < 4; turn++) await loopTurn();
  timers.setImmediate = queue;
  // Both callbacks ran. The overtaken one did nothing, and the other started the delivery.
  expect(work.slice(0, 2)).toEqual([0, 1]);
  expect(delivered).toEqual(["first", "second", "third"]);
  expect(made.root.receiveMessageOnPort(port2)).toBeUndefined();
});

test("a delivery batch that cannot queue its next step ends, and the loop delivers the rest in order", async () => {
  const { made, port1, port2, delivered, timers } = selfTransferRefused();
  // Errors a delivery callback throws are kept here instead of ending the test process.
  const queue = timers.setImmediate, thrown: unknown[] = [];
  timers.setImmediate = callback => queue(() => { try { callback(); } catch (error) { thrown.push(error); } });
  const microtask = globalThis.queueMicrotask, failure = new RangeError("Maximum call stack size exceeded");
  port2.on("message", value => {
    if (value !== "second") return;
    // The step that would continue the batch after this handler cannot be queued.
    globalThis.queueMicrotask = () => { globalThis.queueMicrotask = microtask; throw failure; };
  });
  try {
    port1.postMessage("first"); port1.postMessage("second"); port1.postMessage("third"); port1.postMessage("fourth");
    await loopTurn(); await loopTurn();
    made.root.step();
    for (let turn = 0; turn < 4; turn++) await loopTurn();
    expect(thrown).toEqual([failure]);
    expect(delivered).toEqual(["first", "second"]);
    // Nothing but the loop: its pump finds the delivery owed and queues it.
    made.root.step();
    for (let turn = 0; turn < 4; turn++) await loopTurn();
    expect(delivered).toEqual(["first", "second", "third", "fourth"]);
    expect(made.root.receiveMessageOnPort(port2)).toBeUndefined();
  } finally { globalThis.queueMicrotask = microtask; timers.setImmediate = queue; }
});

/**
 * A transfer call the engine refuses to enter never runs the native, so nothing calls the
 * rollback. The post is still registered, and whatever enters the runtime next rolls it back
 * before doing its own work. Each case below is one kind of next entry.
 */
type Refused = { made: ReturnType<typeof group>; spawned: ReturnType<ReturnType<typeof group>["spawn"]>; extra: { port1: SourcePort; port2: SourcePort }; buffer: ArrayBuffer };
const entries: { name: string; enter(refused: Refused): void; closes?: boolean }[] = [
  { name: "a loop step", enter: ({ made }) => { made.root.step(); } },
  { name: "a synchronous receive on another port", enter: ({ made, extra }) => { made.root.receiveMessageOnPort(extra.port1); } },
  { name: "a post on the sender", enter: ({ spawned }) => { spawned.port.postMessage("next"); } },
  { name: "a reference query on the carried port", enter: ({ extra }) => { extra.port2.hasRef(); } },
  { name: "the carried port sent again", enter: ({ spawned, extra }) => { spawned.port.postMessage({ again: extra.port2 }, [extra.port2]); }, closes: true },
  { name: "the carried port closed", enter: ({ extra }) => { extra.port2.close(); }, closes: true },
];
for (const entry of entries) {
  test(`after a transfer call that throws on entry, ${entry.name} first puts everything back`, async () => {
    const failure = new RangeError("Maximum call stack size exceeded");
    let fail = true, settled = 0;
    const made = group({ beforeTransfer: () => { if (fail) { fail = false; throw failure; } }, settled: () => { settled++; } });
    const spawned = made.spawn();
    const extra = new made.root.MessageChannel();
    const buffer = new ArrayBuffer(32);
    const got: unknown[] = [];
    extra.port2.on("message", value => got.push(value));
    extra.port1.postMessage("queued before");
    expect(() => spawned.port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2])).toThrow(failure);
    expect(settled).toBe(0);
    entry.enter({ made, spawned, extra, buffer });
    // The rollback ran once, before the entry's own work, and left nothing staged.
    expect(settled).toBeGreaterThanOrEqual(1);
    expect(buffer.byteLength).toBe(32);
    expect(made.model.control.staged).toBe(0);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    // A port that then left or closed took its queue with it; otherwise the message queued
    // for the carried port before the failed post is delivered, once.
    if (!entry.closes) expect(got).toEqual(["queued before"]);
    // The receiver saw nothing of the failed post, and the sender's sequence has no gap.
    spawned.port.postMessage("last");
    const seen: unknown[] = [];
    for (let item = spawned.child.receiveMessageOnPort(spawned.child.parentPort); item; item = spawned.child.receiveMessageOnPort(spawned.child.parentPort)) seen.push(item.message);
    expect(seen.at(-1)).toBe("last");
    expect(seen.some(message => typeof message === "object" && message !== null && "buffer" in message)).toBe(false);
  });
}

const interruptible: [object, string][] = [[Set.prototype, "add"], [Set.prototype, "delete"], [Map.prototype, "set"], [Map.prototype, "delete"]];
/** Runs `action` with its `stop`th collection call throwing, before or after it took effect. False when it made fewer. */
function interruptedAt(stop: number, after: boolean, action: () => void): boolean {
  let seen = 0, hit = false;
  const originals = interruptible.map(([target, name]) => Reflect.get(target, name) as (...args: unknown[]) => unknown);
  interruptible.forEach(([target, name], index) => Reflect.set(target, name, function (this: unknown, ...args: unknown[]) {
    if (seen++ !== stop) return Reflect.apply(originals[index]!, this, args);
    hit = true;
    if (after) Reflect.apply(originals[index]!, this, args);
    throw new RangeError("Maximum call stack size exceeded");
  }));
  try { action(); }
  catch (error) { if (!hit) throw error; }
  finally { interruptible.forEach(([target, name], index) => Reflect.set(target, name, originals[index])); }
  return hit;
}

for (const after of [false, true]) {
  test(`a rollback interrupted ${after ? "after" : "before"} any of its collection calls is finished by the next step`, () => {
    let stops = 0;
    for (let stop = 0; ; stop++) {
      const { made, spawned, extra, buffer } = postRefusedOnEntry();
      // The first attempt at the rollback is cut short somewhere; the step after it finishes.
      const reached = interruptedAt(stop, after, () => { made.root.step(); });
      made.root.step();
      expect(extra.port2.hasRef(), `stop ${stop}`).toBe(true);
      expect(made.root.internal.messagePortRefs.size, `stop ${stop}`).toBe(1);
      expectNothingMoved(made, spawned, extra, buffer);
      for (const close of cleanup) close();
      cleanup.clear();
      if (!reached) break;
      stops++;
    }
    expect(stops).toBeGreaterThan(3);
  });
}

test("a worker that exits after a refused post reports only the messages it sent", () => {
  const failure = new RangeError("Maximum call stack size exceeded");
  let fail = false;
  const made = group({ child: { beforeTransfer: () => { if (fail) { fail = false; throw failure; } } } });
  const { child, port, pid } = made.spawn();
  child.parentPort.postMessage("sent");
  fail = true;
  expect(() => child.parentPort.postMessage("refused on entry")).toThrow(failure);
  // The exit report counts the parent port's messages. The refused post took a sequence
  // before its call and gives it back before the report is made.
  child.internal.workerExit?.(0);
  const exiting = made.trace.filter(item => item.from === `child ${pid}` && item.text.includes('"exiting"')).map(item => item.text).join("");
  expect(exiting).toContain('"messages":1');
  expect(made.root.receiveMessageOnPort(port)?.message).toBe("sent");
  expect(made.root.receiveMessageOnPort(port)).toBeUndefined();
});

const tooMany = expect.objectContaining({ name: "DataCloneError", message: "MessagePort has sent too many messages" });

test("the last commit nonce is used, and the post after it is refused before anything is staged", () => {
  const made = group();
  const { child, port } = made.spawn();
  const buffer = new ArrayBuffer(32);
  made.root.__fixtureNonces(2 ** 52 - 2);
  port.postMessage("the last nonce");
  expect(child.receiveMessageOnPort(child.parentPort)?.message).toBe("the last nonce");
  const reserved = made.model.control.reserved;
  expect(() => port.postMessage({ buffer }, [buffer])).toThrow(tooMany);
  expect(() => port.postMessage({ buffer }, [buffer])).toThrow(tooMany);
  expect(buffer.byteLength).toBe(32);
  expect(made.model.control.reserved).toBe(reserved);
  expect(made.model.control.staged).toBe(0);
  expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
});

/** Rewrites the one port a frame still in a lane carries, as if its earlier owner had left it so. */
function rewriteCarriedPort(made: ReturnType<typeof group>, change: (port: { version: number; sent: number }) => void) {
  const directions = made.model.lanes.flatMap(lane => lane.directions).filter(direction => direction.frames.some(text => text.includes('"port"')));
  expect(directions).toHaveLength(1);
  const frames = directions[0]!.frames;
  const frame = JSON.parse(frames[0]!) as { graph: { nodes: [string, { version: number; sent: number }][] } };
  change(frame.graph.nodes.find(node => node[0] === "port")![1]);
  frames[0] = JSON.stringify(frame);
}

test("a port at the last sequence a number holds exactly refuses to post, and one below it posts", () => {
  for (const [sent, refused] of [[Number.MAX_SAFE_INTEGER - 1, false], [Number.MAX_SAFE_INTEGER, true]] as const) {
    const made = group();
    const { child, port } = made.spawn();
    const extra = new made.root.MessageChannel();
    port.postMessage({ port: extra.port2 }, [extra.port2]);
    rewriteCarriedPort(made, carried => { carried.sent = sent; });
    const moved = carried(child.receiveMessageOnPort(child.parentPort)?.message);
    const buffer = new ArrayBuffer(32);
    const reserved = made.model.control.reserved;
    if (!refused) { moved.postMessage({ buffer }, [buffer]); expect(buffer.byteLength).toBe(0); continue; }
    expect(() => moved.postMessage({ buffer }, [buffer])).toThrow(tooMany);
    expect(buffer.byteLength).toBe(32);
    expect(made.model.control.reserved).toBe(reserved);
    expect(made.model.control.staged).toBe(0);
  }
});

test("a port at the last version the lane can record refuses to move, and one below it moves", () => {
  for (const [version, refused] of [[2 ** 32 - 3, false], [2 ** 32 - 2, true]] as const) {
    const made = group();
    const { child, port } = made.spawn();
    const extra = new made.root.MessageChannel();
    port.postMessage({ port: extra.port2 }, [extra.port2]);
    rewriteCarriedPort(made, carried => { carried.version = version; });
    const moved = carried(child.receiveMessageOnPort(child.parentPort)?.message);
    const back = () => child.parentPort.postMessage({ port: moved }, [moved]);
    if (!refused) {
      back();
      const returned = carried(made.root.receiveMessageOnPort(port)?.message);
      returned.postMessage("after the last move");
      expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("after the last move");
      continue;
    }
    expect(back).toThrow(expect.objectContaining({ name: "DataCloneError", message: "MessagePort has moved too many times" }));
    // Refused while preparing: the port is still the child's and still works.
    expect(made.model.control.staged).toBe(0);
    moved.postMessage("still here");
    expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("still here");
    expect(made.root.receiveMessageOnPort(port)).toBeUndefined();
  }
});

test("a commit the core refuses throws DataCloneError with everything put back before the throw", () => {
  let stale = true;
  const made = group({ beforeTransfer: () => {
    if (!stale) return;
    stale = false;
    // The carried end changed after it was staged: its epoch is no longer the one that was named.
    for (const lane of made.model.lanes.slice(1)) lane.ends[0].epoch += 2;
  } });
  const spawned = made.spawn();
  const extra = new made.root.MessageChannel();
  const buffer = new ArrayBuffer(32);
  const calls = made.model.control.calls;
  expect(() => spawned.port.postMessage({ buffer, port: extra.port2 }, [buffer, extra.port2])).toThrow(expect.objectContaining({ name: "DataCloneError", message: "MessagePort changed during transfer" }));
  // The refusal rolled the post back itself: the staged frame is gone with no later entry.
  expect(calls.at(-1)).not.toBe("laneCommitStaged");
  expect(made.model.control.staged).toBe(0);
  for (const lane of made.model.lanes.slice(1)) lane.ends[0].epoch -= 2;
  expectNothingMoved(made, spawned, extra, buffer);
});

test("a buffer the native finds detached is refused with every other buffer attached", () => {
  let detach: ArrayBuffer | null = null;
  const made = group({ beforeTransfer: () => { if (detach) structuredClone(detach, { transfer: [detach] }); detach = null; } });
  const spawned = made.spawn();
  const extra = new made.root.MessageChannel();
  const buffer = new ArrayBuffer(32), gone = new ArrayBuffer(8);
  detach = gone;
  expect(() => spawned.port.postMessage({ buffer, gone, port: extra.port2 }, [buffer, gone, extra.port2])).toThrow(expect.objectContaining({ name: "DataCloneError", message: "ArrayBuffer is not detachable" }));
  expect(made.model.control.calls.includes("laneCommitStaged")).toBe(false);
  expectNothingMoved(made, spawned, extra, buffer);
});

test("a post made from a getter of another post is whole first, and both keep their order", () => {
  const { root, spawn } = group();
  const { child, port } = spawn();
  const extra = new root.MessageChannel();
  const buffer = new ArrayBuffer(32);
  const outer = { buffer, get nested() { port.postMessage({ inner: true, port: extra.port2 }, [extra.port2]); return "ran"; } };
  port.postMessage(outer, [buffer]);
  const first = child.receiveMessageOnPort(child.parentPort)?.message as { inner: boolean; port: SourcePort };
  expect(first.inner).toBe(true);
  expect(child.receiveMessageOnPort(child.parentPort)?.message).toEqual({ buffer: new ArrayBuffer(32), nested: "ran" });
  expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
  first.port.postMessage("carried by the inner post");
  expect(root.receiveMessageOnPort(extra.port1)?.message).toBe("carried by the inner post");
});

test("a post whose getter runs a loop step is given up clean, and the next one goes through", () => {
  const { model, root, spawn } = group();
  const { child, port } = spawn();
  const buffer = new ArrayBuffer(32);
  let step = true;
  const message = { buffer, get stepped() { if (step) root.step(); return 1; } };
  // The step runs inside no post, so it took this one for abandoned and rolled it back.
  expect(() => port.postMessage(message, [buffer])).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  expect(buffer.byteLength).toBe(32);
  expect(model.control.staged).toBe(0);
  expect(child.receiveMessageOnPort(child.parentPort)).toBeUndefined();
  step = false;
  port.postMessage(message, [buffer]);
  expect(child.receiveMessageOnPort(child.parentPort)?.message).toEqual({ buffer: new ArrayBuffer(32), stepped: 1 });
});

test("what a post owes is retried when settling it fails, and the failure is not the post's", () => {
  const failure = new RangeError("Maximum call stack size exceeded");
  let fail = 0, settled = 0;
  const made = group({ settled: () => { if (fail-- > 0) throw failure; settled++; } });
  const { child, port } = made.spawn();
  const extra = new made.root.MessageChannel();
  port.postMessage({ port: extra.port2 }, [extra.port2]);
  fail = 3;
  // The next call into the runtime finds the debt first and fails before doing its own work.
  expect(() => port.postMessage("second")).toThrow(failure);
  // A loop step meets the same failure twice, when it settles and when it pumps. It keeps
  // both to itself and leaves the debt for the next step.
  expect(() => made.root.step()).not.toThrow();
  expect(settled).toBe(0);
  made.root.step();
  expect(settled).toBe(1);
  port.postMessage("third");
  const got: unknown[] = [];
  for (let item = child.receiveMessageOnPort(child.parentPort); item; item = child.receiveMessageOnPort(child.parentPort)) got.push(item.message);
  // The first message was whole all along, and the refused second took no sequence.
  expect(got).toHaveLength(2);
  expect(got[1]).toBe("third");
  (got[0] as { port: SourcePort }).port.postMessage("carried");
  expect(made.root.receiveMessageOnPort(extra.port1)?.message).toBe("carried");
});

test("a carried port is restored and sent on before its first sender ever settles", () => {
  const { root, trace, spawn } = group();
  const first = spawn(), second = spawn();
  const extra = new first.child.MessageChannel();
  // The first worker posts a port to the root and never runs again.
  first.child.parentPort.postMessage({ port: extra.port2 }, [extra.port2]);
  const arrived = root.receiveMessageOnPort(first.port)?.message as { port: SourcePort };
  second.port.postMessage({ port: arrived.port }, [arrived.port]);
  const moved = second.child.receiveMessageOnPort(second.child.parentPort)?.message as { port: SourcePort };
  moved.port.postMessage("to the first worker");
  expect(first.child.receiveMessageOnPort(extra.port1)?.message).toBe("to the first worker");
  // Its record that the port was moving arrives late, at an older version, and changes nothing.
  first.child.step(); first.child.step(); root.step();
  expect(trace.some(item => item.from === `child ${first.pid}` && item.text.includes('"moving"'))).toBe(true);
  extra.port1.postMessage("to the second worker");
  expect(second.child.receiveMessageOnPort(moved.port)?.message).toBe("to the second worker");
});

/**
 * The runtime's real loop (net.js `pumpIo`) drops a waiter whose step throws and hands the error
 * to its `fail`. The worker waiter pumps every control channel, lane and the lane housekeeping of
 * its thread, so it has to come back, and the error has to leave `pumpIo` as it was thrown: the
 * engine driver gives whatever `pumpIo` throws to the thread's uncaught-error handling.
 */
const loopCases = (["root", "worker"] as const).flatMap(thread => (["before", "after"] as const).map(when => ({ thread, when })));
for (const { thread, when } of loopCases) {
  test(`a drain that fails ${when} it read, in a loop step on the ${thread}, is thrown as itself and the loop goes on`, async () => {
    const { model, root, spawn } = group({ realLoop: true });
    const { child, port, pid, pipes } = spawn();
    const [receiver, sender, listening, tag] = thread === "root" ? [root, child.parentPort, port, 1] : [child, port, child.parentPort, pid];
    const got: unknown[] = [];
    let closed = false;
    listening.on("message", value => got.push(value));
    listening.on("close", () => { closed = true; });
    const turn = () => new Promise(resolve => setTimeout(resolve, 5));
    // A pass that made progress is followed by another, as in the engine's loop. No test
    // below calls a synchronous receive: that would read the lane without the loop.
    const passes = () => { for (let pass = 0; pass < 6 && receiver.pumpIo(); pass++); };
    sender.postMessage("first");
    model.control.fault = { native: "laneDrain", when };
    let caught: unknown;
    try { receiver.pumpIo(); } catch (error) { caught = error; }
    expect(model.control.thrown).toHaveLength(1);
    expect(caught).toBe(model.control.thrown[0]);
    // The housekeeping of the failed step still ran, and later ones do.
    const swept = (full: boolean) => model.control.sweeps.filter(item => item.tag === tag && (!full || item.full)).length;
    expect(swept(false)).toBeGreaterThan(0);
    const before = swept(false);
    // The frames the core kept (or never read) arrive through the loop, with what came after.
    sender.postMessage("second");
    passes();
    await turn();
    expect(got).toEqual(["first", "second"]);
    expect(swept(false)).toBeGreaterThan(before);
    // A death anywhere in the group still gets its full sweep on the root, from the loop.
    if (thread === "root") {
      const full = swept(true);
      pipes.child.send({ kind: "up", body: { kind: "gone", path: [9] } });
      passes();
      expect(swept(true)).toBe(full + 1);
    }
    // And a later closure reaches the port through the loop alone.
    sender.close();
    await turn();
    passes();
    await turn();
    expect(closed).toBe(true);
  });
}

for (const thread of ["root", "worker"] as const) {
  test(`the ${thread}'s waiter survives a failed step when no new set entry can be made for it`, async () => {
    const { model, root, spawn } = group({ realLoop: true });
    const { child, port, pid } = spawn();
    const [receiver, sender, listening, tag] = thread === "root" ? [root, child.parentPort, port, 1] : [child, port, child.parentPort, pid];
    const got: unknown[] = [];
    listening.on("message", value => got.push(value));
    const turn = () => new Promise(resolve => setTimeout(resolve, 5));
    const passes = () => { for (let pass = 0; pass < 6 && receiver.pumpIo(); pass++); };
    const pending = Reflect.get(receiver.internal, "ioPending") as () => number;
    const before = pending();
    // From here on, registering a waiter fails: the engine has no memory for one more entry.
    const add = Set.prototype.add as (this: Set<unknown>, value: unknown) => Set<unknown>;
    let refused = 0;
    Set.prototype.add = function (this: Set<unknown>, value: unknown) {
      const waiter = typeof value === "object" && value !== null && "step" in value && "fail" in value;
      if (!waiter) return add.call(this, value);
      refused++;
      throw new RangeError("out of memory");
    } as typeof Set.prototype.add;
    try {
      sender.postMessage("first");
      model.control.fault = { native: "laneDrain", when: "after" };
      let caught: unknown;
      try { receiver.pumpIo(); } catch (error) { caught = error; }
      // The step's own error leaves the loop, not one from putting the waiter back: it never left.
      expect(caught).toBe(model.control.thrown[0]);
      expect(refused).toBe(0);
      expect(pending()).toBe(before);
      // Later loop passes alone deliver what the failed step left and what came after, and
      // the housekeeping goes on. Nothing here is a synchronous receive or a port call.
      const swept = () => model.control.sweeps.filter(item => item.tag === tag).length;
      const sweeps = swept();
      sender.postMessage("second");
      passes();
      await turn();
      expect(got).toEqual(["first", "second"]);
      expect(swept()).toBeGreaterThan(sweeps);
      // And a later closure reaches the port through the same loop.
      let closed = false;
      listening.on("close", () => { closed = true; });
      sender.close();
      await turn();
      passes();
      await turn();
      expect(closed).toBe(true);
      expect(refused).toBe(0);
    } finally { Set.prototype.add = add; }
  });
}

test("one lane that fails to drain does not hold back the thread's other lanes and channels", async () => {
  const { model, root, spawn } = group({ realLoop: true });
  const first = spawn();
  const second = spawn();
  const got: string[] = [];
  first.port.on("message", value => got.push(`first ${value}`));
  second.port.on("message", value => got.push(`second ${value}`));
  first.child.parentPort.postMessage("a");
  second.child.parentPort.postMessage("b");
  // The first lane with frames fails after it read them. The same pass still serves the rest.
  model.control.fault = { native: "laneDrain", when: "after" };
  expect(() => root.pumpIo()).toThrow("core data allocation failed");
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(got).toHaveLength(1);
  for (let pass = 0; pass < 4 && root.pumpIo(); pass++);
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(got.toSorted()).toEqual(["first a", "second b"]);
});

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

/** Makes the next `Set.prototype[name]` call throw, before or after it took effect, as an engine may. */
function interruptSet(name: "add" | "delete", after: boolean) {
  const original = Set.prototype[name] as (this: Set<unknown>, value: unknown) => unknown;
  Reflect.set(Set.prototype, name, function (this: Set<unknown>, value: unknown) {
    Reflect.set(Set.prototype, name, original);
    if (after) original.call(this, value);
    throw new RangeError("Maximum call stack size exceeded");
  });
}

test("a keepalive taken or dropped twice, or across an interruption, never counts twice", () => {
  const { root } = group();
  const refs = root.internal.messagePortRefs;
  const { port1, port2 } = new root.MessageChannel();
  const base = refs.size;
  port1.ref(); port1.ref();
  expect([refs.size - base, port1.hasRef()]).toEqual([1, true]);
  // An interruption leaves the reference either taken or not, and the port agrees with the set.
  for (const after of [false, true]) {
    interruptSet("delete", after);
    expect(() => port1.unref()).toThrow(RangeError);
    expect([refs.size - base, port1.hasRef()]).toEqual(after ? [0, false] : [1, true]);
    port1.unref(); port1.unref();
    expect([refs.size - base, port1.hasRef()]).toEqual([0, false]);
    interruptSet("add", after);
    expect(() => port1.ref()).toThrow(RangeError);
    expect([refs.size - base, port1.hasRef()]).toEqual(after ? [1, true] : [0, false]);
    port1.ref();
    expect([refs.size - base, port1.hasRef()]).toEqual([1, true]);
  }
  // A transferred port gives its reference up with its state, and a closed one too.
  const other = new root.MessageChannel();
  port2.ref();
  expect(refs.size - base).toBe(2);
  other.port1.postMessage(null, [port2]);
  expect(refs.size - base).toBe(1);
  port1.close();
  expect(refs.size - base).toBe(0);
  const channel = new root.BroadcastChannel("keepalive");
  channel.ref();
  expect(refs.size - base).toBe(1);
  channel.unref(); channel.unref(); channel.ref();
  channel.close(); channel.ref();
  expect(refs.size - base).toBe(0);
  other.port1.close();
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
