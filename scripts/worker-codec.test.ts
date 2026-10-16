import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { runInNewContext } from "node:vm";

const scratch = mkdtempSync("/work/tmp/bun-wasm-worker-codec-");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emitted = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
  new URL("../crates/bunwasm-runtime/src/js/worker_codec.ts", import.meta.url).pathname, `${scratch}/codec.js`]);
expect(emitted.exitCode).toBe(0);
const source = readFileSync(`${scratch}/codec.js`, "utf8");

function codec() {
  let restored = 0;
  const factory = runInNewContext(source, {
    ArrayBuffer, Uint8Array, Map, Set, Date, RegExp, DataView, Error, TypeError, RangeError,
    Number, String, Boolean, DOMException, EventTarget,
  });
  const implementation = factory({ native: {
    base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
    base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
    transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
  } }).create({
    isPort: () => false,
    prepare() { throw new Error("Unexpected transfer"); },
    restore(value: unknown) { restored++; return value; },
    activate() {},
  });
  return { implementation, restored: () => restored };
}

test("worker graph preserves cycles, map keys and shared typed-array buffers", () => {
  const { implementation } = codec();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const input = { bytes, view: new DataView(bytes.buffer), map: new Map<unknown, unknown>() };
  input.map.set(input, new Set([input]));
  const output = implementation.decode(implementation.encode(input));
  expect(output.bytes.buffer).toBe(output.view.buffer);
  expect(output.map.get(output).has(output)).toBe(true);
  expect(Array.from(output.bytes)).toEqual([1, 2, 3, 4]);
});

test("worker construction can prepare a transfer without detaching before spawn succeeds", () => {
  const { implementation } = codec();
  const buffer = new ArrayBuffer(4);
  const plan = implementation.prepare(buffer, [buffer]);
  expect(buffer.byteLength).toBe(4);
  plan.commit();
  expect(buffer.byteLength).toBe(0);
  expect(implementation.decode(plan.graph).byteLength).toBe(4);
});

test("failed graph serialization leaves all transfer buffers attached", () => {
  const { implementation } = codec();
  const buffer = new ArrayBuffer(4);
  expect(() => implementation.prepare({ buffer, uncloneable() {} }, [buffer])).toThrow();
  expect(buffer.byteLength).toBe(4);
  expect(() => implementation.prepare(buffer, [buffer, buffer])).toThrow();
  expect(buffer.byteLength).toBe(4);
});

test("a getter that detaches a transfer buffer fails preparation before host spawn", () => {
  const { implementation } = codec();
  const buffer = new ArrayBuffer(4);
  const input = { get value() { buffer.transfer(); return 1; } };
  expect(() => implementation.prepare(input, [buffer])).toThrow();
});

test("a non-detachable buffer cannot partially commit a transfer", () => {
  const { implementation } = codec();
  const a = new ArrayBuffer(4);
  const b = new WebAssembly.Memory({ initial: 1 }).buffer;
  expect(() => implementation.encode({ a, b }, [a, b])).toThrow();
  expect(a.byteLength).toBe(4);
  expect(b.byteLength).toBe(65536);
});

test("malformed queued port graphs fail before creating receiver endpoints", () => {
  const { implementation, restored } = codec();
  const snapshot = { id: "a", peer: "b", version: 1, sent: 0, received: 0, closing: null, closed: false };
  for (const pending of [[[0, { root: 4, nodes: [] }]], [[-1, { root: 0, nodes: [["null"]] }]], [[0]]]) {
    const graph = { root: 0, nodes: [["port", { ...snapshot, pending }, 1], ["array", 0, []]] };
    expect(() => implementation.decode(graph)).toThrow();
    expect(restored()).toBe(0);
  }
});

function channelFactory() {
  const emitted = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
    new URL("../crates/bunwasm-runtime/src/js/worker_channel.ts", import.meta.url).pathname, `${scratch}/channel.js`]);
  expect(emitted.exitCode).toBe(0);
  return runInNewContext(readFileSync(`${scratch}/channel.js`, "utf8"), { TextEncoder, TextDecoder });
}

test("a closed worker input pipe still drains the final incoming control frame", () => {
  const factory = channelFactory();
  const incoming: (Uint8Array | number)[] = [new TextEncoder().encode('{"kind":"exiting"}\n'), 0];
  const channel = factory({ native: {
    hostWrite: () => -1, hostRead: () => incoming.shift() ?? 0, hostClose() {},
  } }).open(1, 2);
  const frames: unknown[] = [];
  expect(() => channel.send({ kind: "late-message" })).not.toThrow();
  channel.pump((frame: unknown) => frames.push(frame));
  expect(frames).toEqual([{ kind: "exiting" }]);
  expect(channel.ended).toBe(true);
  expect(channel.pending).toBe(false);
});

test("truncated worker framing fails once", () => {
  const factory = channelFactory();
  const incoming: (Uint8Array | number)[] = [new TextEncoder().encode('{"kind":'), 0];
  const channel = factory({ native: {
    hostWrite: () => -2, hostRead: () => incoming.shift() ?? 0, hostClose() {},
  } }).open(1, 2);
  expect(() => channel.pump(() => {})).toThrow("Incomplete worker message");
  expect(() => channel.pump(() => {})).not.toThrow();
});

test("closing a failed worker channel discards a partial trailing frame", () => {
  const factory = channelFactory();
  const incoming: (Uint8Array | number)[] = [new TextEncoder().encode('{bad}\npartial'), 0];
  const channel = factory({ native: {
    hostWrite: () => -2, hostRead: () => incoming.shift() ?? 0, hostClose() {},
  } }).open(1, 2);
  expect(() => channel.pump(() => {})).toThrow();
  channel.close();
  expect(() => channel.pump(() => {})).not.toThrow();
});
