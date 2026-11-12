// Browser nested-memory admission through the real NestedHost and Waffle's real group owner. The
// declared maximum is a limit for import matching; the reservation is what the group can supply
// now. Small policy ceilings keep these fast; one row uses the real Bun group policy.
import { describe, expect, test } from "bun:test";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
import { GroupOp } from "../node_modules/waffle/group/protocol.ts";
import { MEMORY_PUBLICATION } from "../src/nested/publication";
import { PAGE, count, counters, errorText, group, handle, type Member, type ReplyOf } from "./nested-host-owner";

type Groups = ReturnType<typeof group>["groups"];

function reserve(member: Member, initial: number, maximum: number) { return member.send({ Reserve: { initial, maximum } }); }
function span(member: Member, memory: number) { return (member.send({ Span: { memory } }) as ReplyOf<"Memory">).Memory; }
function grow(member: Member, memory: number, delta: number) { return member.send({ Grow: { memory, delta } }); }
function bytes(member: Member, pointer: number, length: number) { return new Uint8Array(member.owner.handle.buffer(), pointer, length); }
/** Pages the group can still grow by. */
function room(member: Member, maximumPages: number) { return maximumPages - member.owner.snapshot().committedBytes / PAGE; }

/** Everything a refusal must leave as it was: owner tables, the charge, the free list, the host. */
function ledger(member: Member, groups: Groups) {
  const { committedBytes, freeBytes } = member.owner.snapshot();
  return { ...counters(member.owner), committedBytes, freeBytes, budget: groups.budget.committed, host: member.host.snapshot() };
}

describe("a declared maximum that fits", () => {
  test("is reserved whole and grows to it", () => {
    const { join } = group();
    const member = join();
    const memory = handle(reserve(member, 1, 64));
    expect(span(member, memory)).toMatchObject({ pages: 1, maximum: 64, committed: 64 * PAGE });
    expect(count(grow(member, memory, 63))).toBe(1);
    expect(errorText(grow(member, memory, 1))).toContain("memory growth: NoMem");
    expect(count(grow(member, memory, 0))).toBe(64);
    expect(member.host.snapshot()).toMatchObject({ memories: 1, reservedCommittedBytes: 64 * PAGE, visibleBytes: 64 * PAGE });
  });
});

describe("a declared maximum that cannot fit", () => {
  for (const maximum of [65535, 65536]) test(`admits ${maximum} pages as a limit, on the initial bytes and the preferred growth room`, () => {
    const { join } = group({ maximumPages: 4096 });
    const member = join();
    const memory = handle(reserve(member, 1, maximum));
    expect(span(member, memory)).toMatchObject({ pages: 1, maximum, committed: 1025 * PAGE });
    expect(member.host.snapshot()).toMatchObject({ reservedCommittedBytes: 1025 * PAGE, visibleBytes: PAGE });
  });

  test("growth room halves until it fits, and growth stops at the reservation", () => {
    const { join } = group();
    const member = join();
    const memory = handle(reserve(member, 100, 65536));
    const { pointer } = span(member, memory);
    expect(span(member, memory)).toMatchObject({ pages: 100, maximum: 65536, committed: 356 * PAGE });
    bytes(member, pointer, 1)[0] = 41;
    const before = span(member, memory);
    expect(errorText(grow(member, memory, 257))).toContain("memory growth: NoMem");
    expect(span(member, memory)).toEqual(before);
    expect(count(grow(member, memory, 256))).toBe(100);
    expect(span(member, memory)).toEqual({ ...before, pages: 356 });
    expect(bytes(member, pointer, 1)[0]).toBe(41);
    expect(bytes(member, pointer + 356 * PAGE - 1, 1)[0]).toBe(0);
    expect(errorText(grow(member, memory, 1))).toContain("memory growth: NoMem");
    expect(count(grow(member, memory, 0))).toBe(356);
  });

  test("initial bytes that fit are admitted below a maximum the old rule could not place", () => {
    const { join } = group();
    const member = join();
    const memory = handle(reserve(member, 300, 600));
    expect(span(member, memory)).toMatchObject({ pages: 300, maximum: 600, committed: 428 * PAGE });
  });

  test("the last pages are admitted with no growth room, and then nothing is", () => {
    const { groups, join } = group();
    const member = join();
    // The first memory places the arena page its cell lives in.
    handle(reserve(member, 1, 1));
    const left = room(member, 512);
    const memory = handle(reserve(member, left, 65536));
    expect(span(member, memory)).toMatchObject({ pages: left, maximum: 65536, committed: left * PAGE });
    expect(errorText(grow(member, memory, 1))).toContain("memory growth: NoMem");
    const before = ledger(member, groups);
    expect(errorText(reserve(member, 1, 1))).toBe("region admission: NoMem");
    expect(ledger(member, groups)).toEqual(before);
  });

  test("growth room gives way when the page cell needs the last page", () => {
    const { join } = group({ maximumPages: 2048 });
    const member = join();
    // No arena page exists yet. The preferred room would take every page and leave the cell none.
    const required = room(member, 2048) - 1024;
    const memory = handle(reserve(member, required, 65536));
    expect(span(member, memory)).toMatchObject({ pages: required, committed: (required + 512) * PAGE });
    expect(counters(member.owner)).toMatchObject({ regions: 3, holds: 3 });
  });

  test("the backing budget limits the reservation like the address ceiling does", () => {
    const base = group().join().owner.snapshot().committedBytes;
    const { join } = group({ maximumPages: 4096, budgetBytes: base + 400 * PAGE });
    const member = join();
    const memory = handle(reserve(member, 100, 65536));
    expect(span(member, memory)).toMatchObject({ pages: 100, committed: 356 * PAGE });
  });
});

describe("refusals change nothing", () => {
  const descriptors: readonly [string, number, number, string][] = [
    ["initial bytes that do not fit", 500, 65536, "region admission: NoMem"],
    ["initial bytes and a maximum that do not fit", 500, 600, "region admission: NoMem"],
    ["initial bytes beyond any reservation", 32768, 65536, "region admission: NoMem"],
    ["an initial size above its maximum", 2, 1, "region admission: Inval"],
    ["a maximum beyond wasm32", 1, 65537, "region admission: Inval"],
  ];
  for (const [name, initial, maximum, message] of descriptors) test(`${name} is refused`, () => {
    const { groups, join } = group();
    const member = join();
    const before = ledger(member, groups);
    expect(errorText(reserve(member, initial, maximum))).toBe(message);
    expect(ledger(member, groups)).toEqual(before);
    expect(reserve(member, 1, 2)).toHaveProperty("Handle");
  });

  test("a full region table is not retried at a smaller size", () => {
    const { groups, join } = group({ regions: 1 });
    const member = join();
    const before = ledger(member, groups);
    expect(errorText(reserve(member, 1, 65536))).toBe("region admission: Again");
    expect(ledger(member, groups)).toEqual(before);
  });

  test("a page cell the owner refuses returns the reservation", () => {
    const { join } = group({ regions: 2 });
    const member = join();
    const before = counters(member.owner);
    expect(errorText(reserve(member, 1, 65536))).toBe("region admission: Again");
    expect(counters(member.owner)).toEqual(before);
    expect(member.host.snapshot().memories).toBe(0);
  });

  test("a full local table refuses before the owner reserves anything", () => {
    const { groups, join } = group();
    const member = join();
    Reflect.get(Reflect.get(member.host, "regions"), "slots").length = 4096;
    const before = ledger(member, groups);
    expect(errorText(reserve(member, 1, 2))).toContain("nested resource limit");
    expect(ledger(member, groups)).toEqual(before);
  });
});

describe("zero-page memories", () => {
  test("each owns one charged identity page that never becomes visible past its limit", () => {
    const { join } = group();
    const member = join();
    const first = handle(reserve(member, 0, 0)), second = handle(reserve(member, 0, 0));
    expect(span(member, first)).toMatchObject({ pages: 0, maximum: 0, committed: PAGE });
    expect(span(member, first).pointer).not.toBe(span(member, second).pointer);
    expect(errorText(grow(member, first, 1))).toContain("memory growth: NoMem");
    expect(count(grow(member, first, 0))).toBe(0);
  });

  test("a growable one uses its identity page as page zero", () => {
    const { join } = group({ maximumPages: 4096 });
    const member = join();
    const memory = handle(reserve(member, 0, 65536));
    expect(span(member, memory)).toMatchObject({ pages: 0, maximum: 65536, committed: 1025 * PAGE });
    expect(count(grow(member, memory, 1))).toBe(0);
    expect(bytes(member, span(member, memory).pointer, PAGE).every(byte => byte === 0)).toBe(true);
  });
});

describe("a published reservation", () => {
  test("carries the declared maximum and the owner's extent to a receiver", () => {
    const { join } = group({ maximumPages: 4096 });
    const sender = join(), receiver = join(sender);
    const memory = handle(reserve(sender, 1, 65536));
    bytes(sender, span(sender, memory).pointer, 1)[0] = 77;
    const token = count(sender.send({ PublishMemory: { memory } }));
    const attached = handle(receiver.send({ AttachMemory: { token } }));
    expect(span(receiver, attached)).toEqual(span(sender, memory));
    expect(span(receiver, attached)).toMatchObject({ pages: 1, maximum: 65536, committed: 1025 * PAGE });
    expect(errorText(grow(receiver, attached, 1025))).toContain("memory growth: NoMem");
    expect(count(grow(receiver, attached, 1024))).toBe(1);
    expect(span(sender, memory).pages).toBe(1025);
    expect(errorText(grow(sender, memory, 1))).toContain("memory growth: NoMem");
    expect(bytes(receiver, span(receiver, attached).pointer, 1)[0]).toBe(77);
  });

  /** A publication the guest never makes, so the host's checks are what stands in the way. */
  function forged(member: Member, length: number, maximum: number, pages: number): number {
    const [, data] = member.raw(GroupOp.CREATE, length, PAGE);
    const [, cell, cellAddress] = member.raw(GroupOp.CREATE, 16, 16);
    new Int32Array(member.owner.handle.buffer(), cellAddress!, 4)[0] = pages;
    return member.raw(GroupOp.PUBLISH, MEMORY_PUBLICATION, data!, cell!, maximum)[1]!;
  }

  test("a reservation below its maximum attaches with both bounds", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const attached = handle(receiver.send({ AttachMemory: { token: forged(sender, 2 * PAGE, 4, 1) } }));
    expect(span(receiver, attached)).toMatchObject({ pages: 1, maximum: 4, committed: 2 * PAGE });
    expect(count(grow(receiver, attached, 1))).toBe(1);
    expect(errorText(grow(receiver, attached, 1))).toContain("memory growth: NoMem");
  });

  const refusals: readonly [string, number, number, number][] = [
    ["a reservation that is not whole pages", PAGE + 16, 4, 1],
    ["a page count beyond the reservation", 2 * PAGE, 4, 3],
    ["a reservation beyond its maximum", 3 * PAGE, 2, 1],
    ["an identity page that claims to be visible", PAGE, 0, 1],
  ];
  for (const [name, length, maximum, pages] of refusals) test(`refuses ${name} and keeps no hold`, () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const token = forged(sender, length, maximum, pages);
    const before = counters(sender.owner);
    expect(receiver.send({ AttachMemory: { token } })).toHaveProperty("Error");
    expect(counters(sender.owner)).toEqual(before);
  });
});

describe("the published Oxc parser binding's descriptor", () => {
  test("4000 initial and 65536 maximum pages are admitted in a Bun group, and Rolldown's memory beside it", () => {
    const { groups, join } = group(BUN_MEMORY_GROUP_POLICY);
    const member = join();
    try {
      const memory = handle(reserve(member, 4000, 65536));
      const { pointer } = span(member, memory);
      expect(span(member, memory)).toMatchObject({ pages: 4000, maximum: 65536, committed: 5024 * PAGE });
      bytes(member, pointer + 4000 * PAGE - 1, 1)[0] = 9;
      expect(count(grow(member, memory, 1024))).toBe(4000);
      expect(errorText(grow(member, memory, 1))).toContain("memory growth: NoMem");
      expect(span(member, memory)).toMatchObject({ pointer, pages: 5024, maximum: 65536 });
      expect(Array.from(bytes(member, pointer + 4000 * PAGE - 1, 2))).toEqual([9, 0]);
      // Rolldown's 16384 initial pages share the 2 GiB group with it; a second such memory cannot.
      const rolldown = handle(reserve(member, 16384, 65536));
      expect(span(member, rolldown)).toMatchObject({ pages: 16384, maximum: 65536, committed: 17408 * PAGE });
      const before = ledger(member, groups);
      expect(errorText(reserve(member, 16384, 65536))).toBe("region admission: NoMem");
      expect(ledger(member, groups)).toEqual(before);
    } finally {
      member.lease.stopped();
    }
    expect(groups.budget.committed).toBe(0);
  });
});
