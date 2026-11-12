import { expect, test } from "bun:test";
import { createSharedLaneBuffer, openSharedLane, inlineLaneLimit } from "../web/src/shared-objects/lane";
import { createOverflowGrant, poolControlWords, poolChargedWord, poolDisposedWord, overflowBudget, overflowLimit, slotWord } from "../web/src/shared-objects/lane-overflow";
import { sourceLane } from "./fixtures/shared-objects/source-lane";

function pair(open = openSharedLane) {
  const control = new Int32Array(new SharedArrayBuffer(poolControlWords * 4)), grant = createOverflowGrant();
  if (!grant) throw new Error("This source gate requires native growable shared buffers");
  const overflow = { control, index: 0, arena: grant.arena }, buffer = createSharedLaneBuffer();
  return { control, overflow, buffer, sender: open(buffer, 0, overflow), receiver: open(buffer, 1, overflow) };
}
const large = "λ".repeat(550000);

test("overflow reservation stays invisible, busy until copy, and aborts without refunding growth", () => {
  const { sender, receiver, control } = pair();
  const first = sender.reserve(large)!;
  expect(receiver.drain(() => { throw new Error("Invisible reservation delivered"); })).toBe(0);
  expect(Atomics.load(control, slotWord(0, 1)) & 3).toBe(1);
  const charged = Atomics.load(control, poolChargedWord);
  first.abort(); first.commit();
  expect(Atomics.load(control, slotWord(0, 1)) & 3).toBe(0);
  expect(Atomics.load(control, poolChargedWord)).toBe(charged);
  sender.reserve("before")!.commit(); sender.reserve(large)!.commit(); sender.reserve("after")!.commit();
  expect(() => sender.reserve(large)).toThrow("busy");
  const seen: string[] = []; receiver.drain(text => seen.push(text));
  expect(seen).toEqual(["before", large, "after"]);
  sender.reserve(large)!.commit(); receiver.drain(text => expect(text).toBe(large));
  expect(Atomics.load(control, poolChargedWord)).toBe(charged);
});

test("zero-delta reuse works at full budget, another direction cannot grow, closed capacity stays charged", () => {
  const { sender, receiver, control } = pair();
  sender.reserve(large)!.commit(); receiver.drain(() => {});
  Atomics.store(control, poolChargedWord, overflowBudget);
  sender.reserve(large)!.commit(); receiver.drain(() => {});
  expect(() => receiver.reserve(large)).toThrow("budget exceeded");
  expect(Atomics.load(control, slotWord(0, 0) + 4)).toBe(0);
  receiver.close();
  expect(() => sender.reserve(large)).toThrow("closed");
  expect(Atomics.load(control, poolChargedWord)).toBe(overflowBudget);
});

for (const growth of ["none", "partial"] as const) test(`native growth failure retains only actual capacity, growth=${growth}`, async () => {
  const lane = await sourceLane({ grow(buffer) { if (growth === "partial") buffer.grow(65536); throw new RangeError("grow rejected"); } });
  const { sender, receiver, control, overflow } = pair(lane.openSharedLane);
  expect(() => sender.reserve(large)).toThrow("grow rejected");
  expect(Atomics.load(control, poolChargedWord)).toBe(overflow.arena.byteLength);
  expect(Atomics.load(control, slotWord(0, 1)) & 3).toBe(0);
  expect(Atomics.load(control, slotWord(0, 1) + 4)).toBe(0);
  expect(receiver.drain(() => { throw new Error("Failed growth delivered"); })).toBe(0);
  sender.reserve("small")!.commit(); receiver.drain(text => expect(text).toBe("small"));
});

// Directions share the backing, so a grow call that fails after the bytes exist is what losing a
// race to another direction's larger growth looks like. Both publish.
test("a growth call that throws once the extent is backed still publishes", async () => {
  const lane = await sourceLane({ grow(buffer, length) { buffer.grow(length); throw new RangeError("grow rejected"); } });
  const { sender, receiver, control, overflow } = pair(lane.openSharedLane);
  sender.reserve(large)!.commit();
  expect(receiver.drain(text => expect(text).toBe(large))).toBe(1);
  expect(Atomics.load(control, poolChargedWord)).toBe(overflow.arena.byteLength);
});

test("every direction shares one backing that reserves the runtime budget and no more", () => {
  const grant = createOverflowGrant();
  expect(grant?.arena.maxByteLength).toBe(overflowBudget);
  expect(grant?.arena.byteLength).toBe(0);
});

test("the last extent lengthens in place, and an outgrown one moves with twice the room and stays charged", () => {
  const { sender, receiver, control } = pair();
  const pages = (text: string) => Math.ceil(text.length / 65536) * 65536;
  const small = "a".repeat(1100000), medium = "b".repeat(1500000), big = "c".repeat(1600000);
  const forward = slotWord(0, 1), backward = slotWord(0, 0);
  sender.reserve(small)!.commit(); receiver.drain(text => expect(text).toBe(small));
  sender.reserve(medium)!.commit(); receiver.drain(text => expect(text).toBe(medium));
  expect(Atomics.load(control, forward + 3)).toBe(0);
  expect(Atomics.load(control, poolChargedWord)).toBe(pages(medium));
  receiver.reserve(small)!.commit(); sender.drain(text => expect(text).toBe(small));
  expect(Atomics.load(control, backward + 3)).toBe(pages(medium));
  const charged = Atomics.load(control, poolChargedWord);
  expect(charged).toBe(pages(medium) + pages(small));
  sender.reserve(big)!.commit(); receiver.drain(text => expect(text).toBe(big));
  expect(Atomics.load(control, forward + 3)).toBe(charged);
  expect(Atomics.load(control, forward + 4)).toBe(pages(medium) * 2);
  expect(Atomics.load(control, poolChargedWord)).toBe(charged + pages(medium) * 2);
  receiver.reserve(small)!.commit(); sender.drain(text => expect(text).toBe(small));
  sender.reserve(medium)!.commit(); receiver.drain(text => expect(text).toBe(medium));
  expect(Atomics.load(control, poolChargedWord)).toBe(charged + pages(medium) * 2);
});

test("failed receiver allocation preserves the published descriptor and credit until a retry copies", async () => {
  let fail = false;
  const lane = await sourceLane({ allocate(length) { if (fail && length > inlineLaneLimit) throw new RangeError("copy allocation failed"); } });
  const { sender, receiver, control } = pair(lane.openSharedLane);
  sender.reserve(large)!.commit(); fail = true;
  expect(() => receiver.drain(() => {})).toThrow("copy allocation failed");
  expect(Atomics.load(control, slotWord(0, 1)) & 3).toBe(2);
  fail = false;
  expect(() => sender.reserve(large)).toThrow("busy");
  expect(receiver.drain(text => expect(text).toBe(large))).toBe(1);
});

test("generations use unsigned comparisons and never wrap after exhaustion", () => {
  const { sender, receiver, control } = pair();
  Atomics.store(control, slotWord(0, 1) + 1, 0x7fffffff);
  sender.reserve(large)!.commit(); receiver.drain(text => expect(text).toBe(large));
  Atomics.store(control, slotWord(0, 1) + 1, -2);
  sender.reserve(large)!.commit(); receiver.drain(text => expect(text).toBe(large));
  expect(() => sender.reserve(large)).toThrow("generation exhausted");
  sender.reserve("still inline")!.commit(); receiver.drain(text => expect(text).toBe("still inline"));
});

for (const kind of ["generation", "utf8", "consume"] as const) test(`malformed ${kind} poisons the lane persistently`, () => {
  const { sender, receiver, control, overflow, buffer } = pair();
  sender.reserve(large)!.commit(); sender.reserve("after")!.commit();
  if (kind === "generation") Atomics.add(control, slotWord(0, 1) + 1, 1);
  if (kind === "utf8") new Uint8Array(overflow.arena)[Atomics.load(control, slotWord(0, 1) + 3)] = 0xff;
  const consume = () => { if (kind === "consume") throw new Error("consume failed"); };
  expect(() => receiver.drain(consume)).toThrow();
  expect(() => receiver.drain(() => {})).toThrow();
  expect(() => openSharedLane(buffer, 1, overflow).drain(() => {})).toThrow("terminal error");
  expect(() => sender.reserve("no continuation")).toThrow("closed");
});

test("a descriptor wraps, and a full inline ring cannot reserve it", () => {
  const { sender, receiver, buffer } = pair();
  sender.reserve("x".repeat(inlineLaneLimit - 8))!.commit(); receiver.drain(() => {});
  sender.reserve(large)!.commit(); receiver.drain(text => expect(text).toBe(large));
  sender.reserve("x".repeat(inlineLaneLimit))!.commit();
  expect(sender.reserve(large)).toBeNull();
  expect(Atomics.load(new Int32Array(buffer), 4) >>> 0).toBeGreaterThan(0);
});

for (const phase of ["reserved", "published", "copying"] as const) test(`closure preserves phase ownership at ${phase}`, async () => {
  let closeDuringCopy = false, close = () => {};
  const lane = await sourceLane({ allocate(length) { if (closeDuringCopy && length > inlineLaneLimit) close(); } });
  const { sender, receiver, control } = pair(lane.openSharedLane);
  close = receiver.close;
  const token = sender.reserve(large)!;
  if (phase === "reserved") receiver.close();
  token.commit(); token.abort();
  if (phase === "published") receiver.close();
  closeDuringCopy = phase === "copying";
  expect(receiver.drain(() => { throw new Error("Closed receiver delivered"); })).toBe(0);
  expect(Atomics.load(control, slotWord(0, 1)) & 4).toBe(4);
  expect(() => sender.reserve("closed")).toThrow("closed");
  receiver.close();
});

test("shared disposal rejects both inline reserve and drain even without a native closing event", () => {
  const { sender, receiver, control } = pair();
  Atomics.store(control, poolDisposedWord, 1);
  expect(() => sender.reserve("small")).toThrow("runtime is closed");
  expect(() => receiver.drain(() => {})).toThrow("runtime is closed");
});

test("the inclusive encoded cap succeeds and cap plus one rejects", () => {
  const { sender, receiver } = pair();
  const text = "x".repeat(overflowLimit);
  sender.reserve(text)!.commit();
  receiver.drain(value => expect(value.length).toBe(overflowLimit));
  expect(() => sender.reserve(text + "x")).toThrow("encoded limit");
});

test("two directions saturate the real committed budget, and smaller reuse has zero delta", () => {
  const { sender, receiver, control, overflow, buffer } = pair();
  const text = "x".repeat(overflowLimit);
  sender.reserve(text)!.commit(); receiver.drain(value => expect(value.length).toBe(overflowLimit));
  receiver.reserve(text)!.commit(); sender.drain(value => expect(value.length).toBe(overflowLimit));
  expect(Atomics.load(control, poolChargedWord)).toBe(overflowBudget);
  const lane = openSharedLane(createSharedLaneBuffer(), 0, { control, index: 1, arena: overflow.arena });
  expect(() => lane.reserve(large)).toThrow("budget exceeded");
  sender.reserve(large)!.commit(); receiver.drain(value => expect(value).toBe(large));
  expect(overflow.arena.byteLength).toBe(overflowBudget);
  expect(buffer.byteLength).toBe(2097184);
});

for (const corrupt of ["truncated", "length", "cursor", "phase"] as const) test(`invalid ${corrupt} descriptor is terminal, not empty`, () => {
  const { sender, receiver, buffer, control } = pair();
  sender.reserve(large)!.commit();
  const header = new Int32Array(buffer), descriptor = new DataView(buffer, 32 + 1048576);
  if (corrupt === "truncated") Atomics.store(header, 4, 8);
  if (corrupt === "length") descriptor.setUint32(8, 64 * 1024 * 1024 + 1, true);
  if (corrupt === "cursor") Atomics.store(header, 5, 1);
  if (corrupt === "phase") Atomics.store(control, slotWord(0, 1), 1);
  expect(() => receiver.drain(() => {})).toThrow();
  expect(() => receiver.drain(() => {})).toThrow();
  expect(() => sender.reserve("later")).toThrow("closed");
});

test("missing native growable getters do not break fixed-buffer recognition or inline messages", async () => {
  const lane = await sourceLane({ fixedOnly: true }), buffer = lane.createSharedLaneBuffer();
  expect(lane.nativeSharedFixed(buffer, buffer.byteLength)).toBe(true);
  const a = lane.openSharedLane(buffer, 0), b = lane.openSharedLane(buffer, 1);
  a.reserve("small")!.commit(); expect(b.drain(text => expect(text).toBe("small"))).toBe(1);
  expect(() => a.reserve(large)).toThrow("byte limit");
});
