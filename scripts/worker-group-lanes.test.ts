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
afterEach(() => { for (const close of cleanup) close(); cleanup.clear(); });

type Trace = { from: string; text: string }[];
function host(input: PipeEndpoint, output: PipeEndpoint, from: string, trace: Trace) {
  return {
    procRead() {
      const buffer = new Uint8Array(65536);
      const read = input.tryRead([buffer]);
      return read > 0 ? buffer.slice(0, read) : read;
    },
    procWrite(_fd: number, bytes: Uint8Array) {
      trace.push({ from, text: Buffer.from(bytes).toString("utf8") });
      return output.tryWrite([bytes]);
    },
    procPoll: () => new Uint8Array(0),
    procClose() {},
  };
}

/** Pipes as spawn creates them: the child's reader is retained before the parent's closes. */
function spawnPipes(pid: number, trace: Trace) {
  const down = new PipeController({ capacity: 65536, relay: "manual" });
  const parentWrite = down.retain(1, "write");
  const original = down.retain(1, "read");
  const childRead = down.retain(pid, "read");
  original.close();
  const up = new PipeController({ capacity: 65536 });
  const childWrite = up.retain(pid, "write");
  const parentRead = up.retain(1, "read");
  cleanup.add(() => { for (const end of [parentWrite, childRead, childWrite, parentRead]) end.close(); down.dispose?.(); up.dispose?.(); });
  return {
    parentWrite, childRead,
    parent: sourceChannel(host(parentRead, parentWrite, "parent", trace)),
    child: sourceChannel(host(childRead, childWrite, `child ${pid}`, trace)),
  };
}

type Runtime = ReturnType<typeof sourcePorts>;
function group() {
  const model = createGroupLaneModel();
  const trace: Trace = [];
  const rootLanes = model.member(1);
  const root = sourcePorts({ sharedObjects: groupSharedObjects(rootLanes) });
  cleanup.add(() => root.__fixtureShutdown());
  let next = 2;
  /** Starts a child whose workerData is `data`, carrying `transfer` and its parent port. */
  function spawn(data: unknown = null, transfer: unknown[] = []) {
    const pid = next++;
    const pipes = spawnPipes(pid, trace);
    const lanes = model.member(pid);
    const { port1, port2 } = new root.MessageChannel();
    const cell = rootLanes.cell();
    const plan = root.codec.prepare([data, [], port2], transfer.concat([port2]), [], { kind: "cell", cell });
    plan.commit();
    root.__fixtureChild(pipes.parent, plan.graph);
    const child: Runtime = sourcePorts({ sharedObjects: groupSharedObjects(lanes), channel: pipes.child, graph: plan.graph, lanes: { ledger: 4096, cell } });
    cleanup.add(() => child.__fixtureShutdown());
    child.initialize();
    return { child, port: port1, pipes, cell };
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
