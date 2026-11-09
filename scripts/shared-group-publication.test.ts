import { expect, test } from "bun:test";
import { groupRuntime } from "./fixtures/shared-objects/group-runtime";
import type { Graph } from "./fixtures/shared-objects/runtime-types";

function fixture() {
  const runtime = groupRuntime();
  return { ...runtime, memory: new runtime.api.Memory({ initial: 1, maximum: 2, shared: true }) };
}

test("group publication withdraws fresh tokens when delivery fails after publish", () => {
  const { codec, directory, memory } = fixture();
  const failure = new Error("delivery failed");
  const plan = codec.prepare({ memory });
  expect(() => plan.commit(() => { throw failure; })).toThrow(failure);
  expect(directory.size).toBe(0);
  plan.abort();
  expect(directory.size).toBe(0);
});

test("group publication preserves an inner delivery when an outer getter aborts", () => {
  const { codec, directory, memory } = fixture();
  let delivered: Graph | undefined;
  const failure = new Error("outer getter failed");
  const message = { memory, get nested() {
    const inner = codec.prepare({ memory });
    inner.commit(() => { delivered = inner.graph; });
    throw failure;
  } };
  expect(() => codec.prepare(message)).toThrow(failure);
  expect(directory.size).toBe(1);
  expect(delivered).toBeDefined();
  expect(codec.decode(delivered)).toEqual({ memory });
});

test("group publication keeps a token until all overlapping prepared sends settle", () => {
  const { codec, directory, memory } = fixture();
  const first = codec.prepare({ memory }), second = codec.prepare({ memory });
  first.abort();
  expect(directory.size).toBe(1);
  second.commit();
  expect(directory.size).toBe(1);
  expect(codec.decode(second.graph)).toEqual({ memory });
});

test("group publication releases a token after all overlapping sends abort", () => {
  const { codec, directory, memory } = fixture();
  const first = codec.prepare({ memory }), second = codec.prepare({ memory });
  first.abort();
  second.abort();
  expect(directory.size).toBe(0);
  const later = codec.prepare({ memory });
  later.commit();
  expect(directory.size).toBe(1);
});

test("group publication does not revoke a message already delivered before transfer finalization fails", () => {
  const { codec, directory, memory } = fixture();
  const transfer = new ArrayBuffer(8);
  const plan = codec.prepare({ memory }, [transfer]);
  expect(() => plan.commit(() => { structuredClone(transfer, { transfer: [transfer] }); })).toThrow();
  expect(directory.size).toBe(1);
  expect(codec.decode(plan.graph)).toEqual({ memory });
});

test("failed group deliveries do not exhaust the publication limit", () => {
  const { codec, directory, memory } = fixture();
  const failure = new Error("delivery failed");
  for (let index = 0; index < 4100; index++) {
    expect(() => codec.prepare({ memory }).commit(() => { throw failure; })).toThrow(failure);
    expect(directory.size).toBe(0);
  }
  const later = codec.prepare({ memory });
  later.commit();
  expect(codec.decode(later.graph)).toEqual({ memory });
});
