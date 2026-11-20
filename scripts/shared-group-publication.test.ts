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

const WITHDRAWN = 0, WITHDRAW_ABSENT = 1;

/** Collects the warnings `action` emits. */
function warnings(action: () => void): string[] {
  const seen: string[] = [], emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error) => { seen.push(String(warning)); }) as typeof process.emitWarning;
  try { action(); }
  finally { process.emitWarning = emit; }
  return seen;
}

test("a withdrawal whose reply was lost is asked again and answered absent", () => {
  const { codec, control, directory, memory, settle } = fixture();
  control.faults.push("lost-after");
  expect(warnings(() => codec.prepare({ memory }).abort())).toEqual([]);
  expect(directory.size).toBe(0);
  expect(control.withdrawals).toEqual([[1, WITHDRAWN]]);
  settle();
  expect(control.withdrawals).toEqual([[1, WITHDRAWN], [1, WITHDRAW_ABSENT]]);
  settle();
  expect(control.withdrawals.length).toBe(2);
  // The memory is published again under a new token, and the stale request cannot reach it.
  const later = codec.prepare({ memory });
  later.commit();
  expect(Array.from(directory.keys())).toEqual([2]);
  expect(codec.decode(later.graph)).toEqual({ memory });
});

test("a withdrawal lost before the directory acted stays owed until it is answered", () => {
  const { codec, control, directory, memory, settle } = fixture();
  control.faults.push("lost-before", "lost-before");
  codec.prepare({ memory }).abort();
  expect(directory.size).toBe(1);
  settle();
  expect(directory.size).toBe(1);
  // A send prepared while the first token is still owed gets its own publication.
  const later = codec.prepare({ memory });
  expect(Array.from(directory.keys())).toEqual([1, 2]);
  settle(); settle();
  expect(control.withdrawals).toEqual([[1, WITHDRAWN]]);
  later.commit();
  settle();
  expect(Array.from(directory.keys())).toEqual([2]);
  expect(control.withdrawals).toEqual([[1, WITHDRAWN]]);
  // Withdrawing the first token left the second one in place for the next send.
  codec.prepare({ memory }).commit();
  expect(Array.from(directory.keys())).toEqual([2]);
});

test("the host's refusal gives a publication up once, with a warning, and it is never asked again", () => {
  const { codec, control, directory, memory, settle } = fixture();
  control.faults.push("refused");
  const plan = codec.prepare({ memory });
  const said = warnings(() => plan.abort());
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("Shared publication 1 could not be withdrawn");
  expect(warnings(() => { for (let index = 0; index < 8; index++) settle(); })).toEqual([]);
  expect(control.asked).toBe(1);
  expect(directory.size).toBe(1);
  // The memory is not stuck: it is published again under a new token.
  const later = codec.prepare({ memory });
  later.commit();
  expect(Array.from(directory.keys())).toEqual([1, 2]);
});

// An error the host replied with is thrown by the guest's native. It is not the host's answer:
// the host caught something before the group owner acted, or after. However final its name,
// text or code looks, the withdrawal stays owed and is asked again.
test("a host error before the owner acted leaves the publication owed, and asking again withdraws it", () => {
  const { codec, control, directory, memory, settle } = fixture();
  control.faults.push("host-error-before");
  expect(warnings(() => codec.prepare({ memory }).abort())).toEqual([]);
  expect(directory.size).toBe(1);
  expect(warnings(() => settle())).toEqual([]);
  expect(directory.size).toBe(0);
  expect(control.withdrawals).toEqual([[1, WITHDRAWN]]);
  expect(control.asked).toBe(2);
});

test("a host error after the owner acted leaves it owed too, and asking again is answered absent", () => {
  const { codec, control, directory, memory, settle } = fixture();
  control.faults.push("host-error-after");
  expect(warnings(() => codec.prepare({ memory }).abort())).toEqual([]);
  expect(directory.size).toBe(0);
  // A later publication of the same memory is not what the repeated request reaches.
  const later = codec.prepare({ memory });
  later.commit();
  expect(warnings(() => settle())).toEqual([]);
  expect(control.withdrawals).toEqual([[1, WITHDRAWN], [1, WITHDRAW_ABSENT]]);
  expect(Array.from(directory.keys())).toEqual([2]);
  settle(); settle();
  expect(control.asked).toBe(2);
});

test("a host that never answers is asked ever more rarely, and the withdrawal is never dropped", () => {
  const { codec, control, directory, memory, settle } = fixture();
  control.always = "host-error-before";
  expect(warnings(() => codec.prepare({ memory }).abort())).toEqual([]);
  expect(warnings(() => { for (let index = 0; index < 100; index++) settle(); })).toEqual([]);
  // Asked at the abort and then after 1, 2, 4, 8, 16 and 32 further settles: not on each.
  expect(control.asked).toBe(7);
  expect(directory.size).toBe(1);
  // No limit: when the host answers at last, however late, the publication goes.
  control.always = null;
  for (let index = 0; index < 64 && directory.size; index++) settle();
  expect(directory.size).toBe(0);
  expect(control.withdrawals).toEqual([[1, WITHDRAWN]]);
  const asked = control.asked;
  for (let index = 0; index < 8; index++) settle();
  expect(control.asked).toBe(asked);
});

type Scenario = { name: string; published: number; run(runtime: ReturnType<typeof fixture>): () => void };
const scenarios: Scenario[] = [
  { name: "one aborted send", published: 0, run: ({ codec, memory }) => { const plan = codec.prepare({ memory }); return () => plan.abort(); } },
  { name: "an aborted send overlapping a committed one", published: 1, run: ({ codec, memory }) => {
    const first = codec.prepare({ memory }), second = codec.prepare({ memory });
    return () => { first.abort(); second.commit(); };
  } },
  { name: "a committed send overlapping an aborted one", published: 1, run: ({ codec, memory }) => {
    const first = codec.prepare({ memory }), second = codec.prepare({ memory });
    return () => { first.commit(); second.abort(); };
  } },
  { name: "two overlapping aborted sends", published: 0, run: ({ codec, memory }) => {
    const first = codec.prepare({ memory }), second = codec.prepare({ memory });
    return () => { first.abort(); second.abort(); };
  } },
  { name: "a send whose preparation is interrupted", published: 0, run: ({ codec, memory }) => () => { codec.prepare({ memory }).abort(); } },
  { name: "a send whose preparation is interrupted and whose withdrawal is lost once", published: 0, run: ({ codec, control, memory }) => {
    control.faults.push("lost-before");
    return () => { codec.prepare({ memory }).abort(); };
  } },
];
const collections: [object, string][] = [[Set.prototype, "add"], [Set.prototype, "delete"], [Map.prototype, "set"], [Map.prototype, "delete"]];

/** Runs `action` with the `stop`th collection call throwing, before or after it took effect, as
 * an engine may at any call. False when `action` made fewer calls than that. */
function interrupted(stop: number, after: boolean, action: () => void): boolean {
  let seen = 0, hit = false;
  const originals = collections.map(([target, name]) => Reflect.get(target, name) as (...args: unknown[]) => unknown);
  collections.forEach(([target, name], index) => Reflect.set(target, name, function (this: unknown, ...args: unknown[]) {
    if (seen++ !== stop) return Reflect.apply(originals[index]!, this, args);
    hit = true;
    if (after) Reflect.apply(originals[index]!, this, args);
    throw new RangeError("Maximum call stack size exceeded");
  }));
  try { action(); }
  catch (error) { if (!hit) throw error; }
  finally { collections.forEach(([target, name], index) => Reflect.set(target, name, originals[index])); }
  return hit;
}

for (const scenario of scenarios) for (const after of [false, true]) {
  test(`${scenario.name}, interrupted ${after ? "after" : "before"} each collection call, settles exactly`, () => {
    let stops = 0;
    for (let stop = 0; ; stop++) {
      const runtime = fixture();
      const action = scenario.run(runtime);
      const reached = interrupted(stop, after, action);
      runtime.settle();
      const effective = runtime.control.withdrawals.filter(([, answer]) => answer === WITHDRAWN);
      expect(runtime.directory.size, `stop ${stop}`).toBe(scenario.published);
      // Every token that was published and is not kept was withdrawn, each once.
      expect(effective.length, `stop ${stop}`).toBe(runtime.control.published - scenario.published);
      // Nothing is left owed: a later settle asks the directory nothing.
      const asked = runtime.control.withdrawals.length;
      runtime.settle();
      expect(runtime.control.withdrawals.length, `stop ${stop}`).toBe(asked);
      // And the memory still travels.
      const later = runtime.codec.prepare({ memory: runtime.memory });
      later.commit();
      expect(runtime.codec.decode(later.graph)).toEqual({ memory: runtime.memory });
      if (!reached) break;
      stops++;
    }
    expect(stops).toBeGreaterThan(3);
  });
}

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
