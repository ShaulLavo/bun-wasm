import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-worker-codec-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emitted = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
  new URL("../crates/bunwasm-runtime/src/js/worker_codec.ts", import.meta.url).pathname, `${scratch}/codec.js`]);
expect(emitted.exitCode).toBe(0);
const source = readFileSync(`${scratch}/codec.js`, "utf8");

function codec() {
  let restored = 0;
  const processEnv = new Proxy({ CENSUS_VALUE: "kept" }, {});
  const ordinaryProxy = new Proxy({ value: "rejected" }, {});
  const proxies = new Set<object>([processEnv, ordinaryProxy]);
  const factory = runInNewContext(source, {
    ArrayBuffer, Uint8Array, Map, Set, Date, RegExp, DataView, Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError,
    Number, String, Boolean, DOMException, EventTarget, Blob, Promise, Symbol, Proxy,
  });
  const implementation = factory({
    native: {
      base64Encode: (bytes: Uint8Array) => Buffer.from(bytes).toString("base64"),
      base64Decode: (value: string) => new Uint8Array(Buffer.from(value, "base64")),
      transferArrayBuffers: (buffers: ArrayBuffer[]) => structuredClone(undefined, { transfer: buffers }),
    },
    require(name: string) {
      if (name === "process") return { env: processEnv };
      throw new Error(`Unexpected module ${name}`);
    },
    isProxy(value: unknown) { return typeof value === "object" && value !== null && proxies.has(value); },
  }).create({
    isPort: () => false,
    prepare() { throw new Error("Unexpected transfer"); },
    restore(value: unknown) { restored++; return value; },
    activate() {},
  });
  return { implementation, restored: () => restored, processEnv, ordinaryProxy };
}


test("process.env keeps object cloning when its tag says Promise, Error, or BigInt", () => {
  const { implementation, processEnv } = codec();
  for (const value of ["Promise", "Error", "BigInt"]) {
    Object.defineProperty(processEnv, Symbol.toStringTag, { configurable: true, value });
    const output = implementation.decode(implementation.encode(processEnv));
    expect(output).toEqual({ CENSUS_VALUE: "kept" });
  }
});

test("ordinary proxies remain uncloneable", () => {
  const { implementation, ordinaryProxy } = codec();
  expect(() => implementation.encode(ordinaryProxy)).toThrow("The object cannot be cloned");
});

test("error fields match Bun structuredClone after JSON graph serialization", () => {
  const { implementation } = codec();
  const fields: [string, unknown][] = [["name", undefined], ["name", 7], ["message", undefined],
    ["message", null], ["message", 42], ["stack", undefined], ["stack", null], ["stack", 1n], ["stack", ""]];
  for (const [key, value] of fields) {
    const error = new Error("diagnostic");
    Object.defineProperty(error, key, { configurable: true, value });
    const expected = structuredClone(error);
    const output = implementation.decode(JSON.parse(JSON.stringify(implementation.encode(error))));
    expect(output).toBeInstanceOf(Error);
    if (!(output instanceof Error)) throw new Error("Expected a cloned Error");
    expect(output.name).toBe(expected.name);
    expect(output.message).toBe(expected.message);
    expect(output.stack).toBe(expected.stack);
  }
});

test("error names use Bun's standard constructors and fallback for custom or inherited names", () => {
  const { implementation } = codec();
  for (const name of ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "EvalError",
    "CustomError", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const error = Object.assign(new Error("payload"), { name });
    const expected = structuredClone(error);
    const output = implementation.decode(implementation.encode(error));
    expect(output).toBeInstanceOf(Error);
    if (!(output instanceof Error)) throw new Error("Expected a cloned Error");
    expect(Object.getPrototypeOf(output)).toBe(Object.getPrototypeOf(expected));
    expect(output.name).toBe(expected.name);
    expect(output.message).toBe(expected.message);
    expect(output.stack).toBe(expected.stack);
  }
});

test("incoming error graphs reject non-normalized fields before restoring ports", () => {
  const { implementation, restored } = codec();
  const fields: [number, unknown][] = [[1, 7], [2, null], [3, 1n], [4, 99]];
  for (const [index, value] of fields) {
    const node: unknown[] = ["error", "Error", "diagnostic", "stack", 3];
    node[index] = value;
    const snapshot = { id: "a", peer: "b", version: 1, sent: 0, received: 0, pending: [], closing: null, closed: false };
    const graph = { root: 0, nodes: [["array", 2, [["0", 1], ["1", 2]]], ["port", snapshot, 4], node, ["undefined"], ["array", 0, []]] };
    expect(() => implementation.decode(graph)).toThrow("Invalid worker message graph");
  }
  expect(restored()).toBe(0);
});

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

function channelFactory(Encoder: new() => { encode(text: string): Uint8Array } = TextEncoder) {
  const emitted = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
    new URL("../crates/bunwasm-runtime/src/js/worker_channel.ts", import.meta.url).pathname, `${scratch}/channel.js`]);
  expect(emitted.exitCode).toBe(0);
  return runInNewContext(readFileSync(`${scratch}/channel.js`, "utf8"), { TextEncoder: Encoder, TextDecoder });
}

/**
 * One guest's core as its control channels see it: pipes that take `capacity` bytes a write, and
 * one slot for the last write attempt that ran, whichever descriptor it was on. `fault` makes
 * the next write fail once on its way to the core or back. `scope: "token"` is a core that
 * compares the token alone, the weakest slot a guest's tokens must still be safe against.
 */
function guestCore(fault: "before" | "after" | null = null, scope: "attempt" | "token" = "attempt", capacity = Infinity) {
  const written = new Map<number, string>();
  const tokens: number[] = [];
  let last = { fd: 0, token: 0, result: 0 };
  /** `lookups`: how many times asking for a write's result fails before the core is entered. */
  const control = { fault, lookups: 0 };
  const native = {
    procWriteOnce(fd: number, bytes: Uint8Array, token: number) {
      const failing = control.fault;
      control.fault = null;
      tokens.push(token);
      if (failing === "before") throw new Error("core data allocation failed");
      const taken = Math.min(bytes.length, capacity);
      written.set(fd, (written.get(fd) ?? "") + new TextDecoder().decode(bytes.subarray(0, taken)));
      last = { fd, token, result: taken };
      if (failing === "after") throw new Error("core data allocation failed");
      return taken;
    },
    procWriteResult(fd: number, high: number, low: number) {
      if (control.lookups > 0) { control.lookups--; throw new RangeError("Maximum call stack size exceeded"); }
      const same = last.token === high * 2 ** 32 + low && (scope === "token" || last.fd === fd);
      return same ? last.result : -(2 ** 63);
    },
    procRead: () => -6, procClose() {},
  };
  return { native, written, tokens, control };
}

for (const when of ["before", "after"] as const) {
  test(`a control frame whose write fails ${when} the pipe took it is written exactly once`, () => {
    const core = guestCore(when);
    const channel = channelFactory()({ native: core.native }).open(1, 2);
    expect(() => channel.send({ kind: "moving", id: 1 })).not.toThrow();
    // A write that never ran leaves the frame queued; one that ran is counted from its attempt.
    expect(channel.pending).toBe(when === "before");
    channel.send({ kind: "port-wake" });
    expect(channel.pending).toBe(false);
    expect(core.written.get(2)).toBe('{"kind":"moving","id":1}\n{"kind":"port-wake"}\n');
  });
}

for (const scope of ["attempt", "token"] as const) {
  test(`a write that never ran on one channel is not answered by another channel's write (core slot by ${scope})`, () => {
    // One guest: one module, two control channels, and one core slot for the last attempt.
    const core = guestCore(null, scope);
    const guest = channelFactory()({ native: core.native });
    const first = guest.open(1, 2), second = guest.open(3, 4);
    // The first channel's write runs and replies, so the slot holds its attempt and byte count.
    first.send({ kind: "to-a" });
    expect(core.written.get(2)).toBe('{"kind":"to-a"}\n');
    // The second channel's first write never reaches the core. Its frame is as long as the
    // first one's: a count read from the first attempt would drop it whole.
    core.control.fault = "before";
    second.send({ kind: "to-b" });
    expect(second.pending).toBe(true);
    expect(core.written.get(4)).toBeUndefined();
    second.pump(() => {});
    expect(second.pending).toBe(false);
    expect(core.written.get(4)).toBe('{"kind":"to-b"}\n');
    expect(core.written.get(2)).toBe('{"kind":"to-a"}\n');
    // Every attempt of the guest has its own token, on whichever channel it was made.
    expect(new Set(core.tokens).size).toBe(core.tokens.length);
    expect(core.tokens.length).toBe(3);
  });
}

const twoChannelCases = (["before", "after"] as const).flatMap(when => (["attempt", "token"] as const).flatMap(scope =>
  [true, false].flatMap(equal => [Infinity, 5].map(capacity => ({ when, scope, equal, capacity })))));
for (const { when, scope, equal, capacity } of twoChannelCases) {
  const frames = `${equal ? "equal" : "unequal"} frames, ${capacity === 5 ? "partial" : "whole"} writes`;
  test(`two channels, a write failing ${when} it ran: each frame is written once (${frames}, core slot by ${scope})`, () => {
    const core = guestCore(null, scope, capacity);
    const guest = channelFactory()({ native: core.native });
    const first = guest.open(1, 2), second = guest.open(3, 4);
    const toFirst = { kind: "to-a" };
    const toSecond = equal ? { kind: "to-b" } : { kind: "to-b", longer: "x".repeat(23) };
    const settle = () => { for (let turn = 0; turn < 16 && (first.pending || second.pending); turn++) { first.pump(() => {}); second.pump(() => {}); } };
    first.send(toFirst);
    settle();
    // The slot now holds the first channel's last attempt. The second channel's first write
    // fails on its way to the core, or on its way back after the pipe took its bytes.
    core.control.fault = when;
    second.send(toSecond);
    if (when === "before") expect(core.written.get(4)).toBeUndefined();
    settle();
    first.send(toFirst);
    settle();
    // Nothing dropped, repeated, skipped or reordered on either pipe.
    expect(core.written.get(4)).toBe(JSON.stringify(toSecond) + "\n");
    expect(core.written.get(2)).toBe((JSON.stringify(toFirst) + "\n").repeat(2));
    expect(first.pending || second.pending).toBe(false);
    expect(new Set(core.tokens).size).toBe(core.tokens.length);
  });
}

// A write's reply is lost, and then its result cannot even be asked for: the engine refuses to
// enter that call. Nothing may be written until the result is known, on any channel, however
// many flushes that takes, or bytes the pipe already took would be written again.
const unknownCases = (["before", "after"] as const).flatMap(when => [Infinity, 5].flatMap(capacity => [1, 4].map(lookups => ({ when, capacity, lookups }))));
for (const { when, capacity, lookups } of unknownCases) {
  const kind = `${capacity === 5 ? "partial" : "whole"} write lost ${when} it ran, result unavailable ${lookups} time${lookups > 1 ? "s" : ""}`;
  test(`a frame is written once and in order across flushes (${kind})`, () => {
    const core = guestCore(when, "attempt", capacity);
    const channel = channelFactory()({ native: core.native }).open(1, 2);
    const first = { kind: "moving", id: 1 }, second = { kind: "port-wake" };
    core.control.lookups = lookups;
    expect(() => channel.send(first)).not.toThrow();
    // The outcome is unknown: the frame stays queued and nothing more was attempted.
    expect(channel.pending).toBe(true);
    expect(core.tokens).toHaveLength(1);
    const taken = core.written.get(2) ?? "";
    // A pump flushes twice, so it asks at most twice. While the core still cannot be asked
    // after it, the outcome is still unknown: not one more byte and not one more attempt.
    while (core.control.lookups >= 2) {
      expect(() => channel.pump(() => {})).not.toThrow();
      expect(core.written.get(2) ?? "").toBe(taken);
      expect(core.tokens).toHaveLength(1);
    }
    for (let turn = 0; turn < 32 && channel.pending; turn++) channel.pump(() => {});
    channel.send(second);
    for (let turn = 0; turn < 32 && channel.pending; turn++) channel.pump(() => {});
    expect(core.written.get(2)).toBe(JSON.stringify(first) + "\n" + JSON.stringify(second) + "\n");
    expect(channel.pending).toBe(false);
    expect(new Set(core.tokens).size).toBe(core.tokens.length);
  });

  test(`another channel of the guest does not write over an unknown result (${kind})`, () => {
    const core = guestCore(null, "attempt", capacity);
    const guest = channelFactory()({ native: core.native });
    const first = guest.open(1, 2), second = guest.open(3, 4);
    const toFirst = { kind: "to-a", text: "a".repeat(11) }, toSecond = { kind: "to-b" };
    core.control.fault = when;
    core.control.lookups = lookups;
    first.send(toFirst);
    expect(core.tokens).toHaveLength(1);
    // The core keeps one result, the last attempt's. A write by the second channel now would
    // replace it and the first channel could never learn what its own write came to.
    for (let flush = 1; flush < lookups; flush++) {
      second.send(toSecond);
      expect(core.tokens).toHaveLength(1);
      expect(core.written.get(4)).toBeUndefined();
    }
    for (let turn = 0; turn < 64 && (first.pending || second.pending); turn++) { second.pump(() => {}); first.pump(() => {}); }
    second.send(toSecond);
    for (let turn = 0; turn < 64 && (first.pending || second.pending); turn++) { second.pump(() => {}); first.pump(() => {}); }
    expect(core.written.get(2)).toBe(JSON.stringify(toFirst) + "\n");
    expect(core.written.get(4)).toBe((JSON.stringify(toSecond) + "\n").repeat(lookups));
    expect(first.pending || second.pending).toBe(false);
    expect(new Set(core.tokens).size).toBe(core.tokens.length);
  });
}

test("closing a channel gives up its unknown write, and the guest's other channels write again", () => {
  const core = guestCore("after", "attempt", 5);
  const guest = channelFactory()({ native: core.native });
  const first = guest.open(1, 2), second = guest.open(3, 4);
  core.control.lookups = 1000;
  first.send({ kind: "to-a" });
  second.send({ kind: "to-b" });
  expect(core.written.get(4)).toBeUndefined();
  first.close();
  for (let turn = 0; turn < 32 && second.pending; turn++) second.pump(() => {});
  expect(core.written.get(4)).toBe('{"kind":"to-b"}\n');
});

test("a control frame that could not be encoded stays queued in order", () => {
  let failing = true;
  class FlakyEncoder {
    encode(text: string) {
      if (failing) { failing = false; throw new Error("core data allocation failed"); }
      return new TextEncoder().encode(text);
    }
  }
  const core = guestCore();
  const channel = channelFactory(FlakyEncoder)({ native: core.native }).open(1, 2);
  expect(() => channel.send({ kind: "moving", id: 1 })).not.toThrow();
  expect(channel.pending).toBe(true);
  expect(core.written.size).toBe(0);
  channel.send({ kind: "port-wake" });
  expect(core.written.get(2)).toBe('{"kind":"moving","id":1}\n{"kind":"port-wake"}\n');
});

test("a closed worker input pipe still drains the final incoming control frame", () => {
  const factory = channelFactory();
  const incoming: (Uint8Array | number)[] = [new TextEncoder().encode('{"kind":"exiting"}\n'), 0];
  const channel = factory({ native: {
    procWriteOnce: () => -64, procRead: () => incoming.shift() ?? 0, procClose() {},
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
    procWriteOnce: () => -6, procRead: () => incoming.shift() ?? 0, procClose() {},
  } }).open(1, 2);
  expect(() => channel.pump(() => {})).toThrow("Incomplete worker message");
  expect(() => channel.pump(() => {})).not.toThrow();
});

test("closing a failed worker channel discards a partial trailing frame", () => {
  const factory = channelFactory();
  const incoming: (Uint8Array | number)[] = [new TextEncoder().encode('{bad}\npartial'), 0];
  const channel = factory({ native: {
    procWriteOnce: () => -6, procRead: () => incoming.shift() ?? 0, procClose() {},
  } }).open(1, 2);
  expect(() => channel.pump(() => {})).toThrow();
  channel.close();
  expect(() => channel.pump(() => {})).not.toThrow();
});
