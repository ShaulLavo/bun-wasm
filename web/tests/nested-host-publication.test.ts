// Publication, attachment and retirement through the real NestedHost and Waffle's real group owner.
import { describe, expect, test } from "bun:test";
import { GroupOp } from "../node_modules/waffle/group/protocol.ts";
import { MEMORY_PUBLICATION, MODULE_PUBLICATION } from "../src/nested/publication";
import { BACKEND, MAX_RESOURCES } from "../src/nested/wire";
import { PAGE, count, counters, errorText, group, handle, type Member, type ReplyOf } from "./nested-host-owner";

const encoder = new TextEncoder();

function memoryRegions(member: Member, length: number) {
  const [, data, base] = member.raw(GroupOp.CREATE, length, PAGE);
  const [, cell, cellAddress] = member.raw(GroupOp.CREATE, 16, 16);
  return { data: data!, base: base!, cell: cell!, cellAddress: cellAddress! };
}

/** A publication the guest never makes, so the host's checks are what stands in the way. */
function forgedMemory(member: Member, length: number, meta: number, edit?: (cells: Int32Array) => void): number {
  const { data, cell, cellAddress } = memoryRegions(member, length);
  if (edit) edit(new Int32Array(member.owner.handle.buffer(), cellAddress, 4));
  return member.raw(GroupOp.PUBLISH, MEMORY_PUBLICATION, data, cell, meta)[1]!;
}

function forgedModule(member: Member, description: Uint8Array, code: Uint8Array, claimed = description.length): number {
  const [, region, address] = member.raw(GroupOp.CREATE, description.length + code.length, 16);
  const target = new Uint8Array(member.owner.handle.buffer(), address!, description.length + code.length);
  target.set(description);
  target.set(code, description.length);
  const token = member.raw(GroupOp.PUBLISH, MODULE_PUBLICATION, region!, 0, claimed)[1]!;
  member.raw(GroupOp.DETACH, region!);
  return token;
}

const description = encoder.encode('{"memory":{},"imports":[],"exports":[]}');
const emptyModule = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const tableModule = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 4, 4, 1, 0x70, 0, 1, 7, 5, 1, 1, 0x74, 1, 0]);
const globalModule = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 6, 6, 1, 0x7f, 0, 0x41, 0, 0x0b, 7, 5, 1, 1, 0x67, 3, 0]);

function compileLocal(member: Member): number {
  const memory = (member.host as unknown as { shared(): WebAssembly.Memory }).shared();
  const pointer = forgedHeap(member, emptyModule.length);
  new Uint8Array(memory.buffer, pointer, emptyModule.length).set(emptyModule);
  return handle(member.send({ Compile: { pointer, length: emptyModule.length } }));
}
function forgedHeap(member: Member, length: number): number {
  const [, , address] = member.raw(GroupOp.CREATE, length, 16);
  return address!;
}

describe("published memories", () => {
  test("a second member sees the same pages and one growth counter", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 3 } }));
    expect(memory >>> 0).toBeGreaterThanOrEqual(BACKEND);
    const token = count(sender.send({ PublishMemory: { memory } }));
    const attached = handle(receiver.send({ AttachMemory: { token } }));
    const left = sender.send({ Span: { memory } }) as ReplyOf<"Memory">;
    const right = receiver.send({ Span: { memory: attached } }) as ReplyOf<"Memory">;
    expect(right.Memory).toEqual(left.Memory);
    expect(count(receiver.send({ Grow: { memory: attached, delta: 1 } }))).toBe(1);
    expect((sender.send({ Span: { memory } }) as ReplyOf<"Memory">).Memory.pages).toBe(2);
    expect(count(sender.send({ Grow: { memory, delta: 0 } }))).toBe(2);
    expect(errorText(sender.send({ Grow: { memory, delta: 2 } }))).toContain("NoMem");
    expect((receiver.send({ Span: { memory: attached } }) as ReplyOf<"Memory">).Memory.pages).toBe(2);
  });

  test("a release returns both holds, and the publication keeps the region until withdrawn", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const before = counters(sender.owner);
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    const token = count(sender.send({ PublishMemory: { memory } }));
    const attached = handle(receiver.send({ AttachMemory: { token } }));
    expect(count(receiver.send({ Release: { memory: attached } }))).toBe(0);
    expect(count(sender.send({ Release: { memory } }))).toBe(0);
    expect(counters(sender.owner)).toEqual({ ...before, regions: before.regions + 2, published: 1 });
    expect(count(sender.send({ Withdraw: { token } }))).toBe(0);
    expect(counters(sender.owner)).toEqual(before);
  });

  test("tokens are full u32 values and a withdrawn one stays stale", () => {
    const { groups, join } = group();
    const sender = join(), receiver = join(sender);
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    Reflect.set(Reflect.get(groups, "tokens"), "next", 0xfffffffe);
    const first = count(sender.send({ PublishMemory: { memory } }));
    expect(first).toBe(0xfffffffe);
    const attached = handle(receiver.send({ AttachMemory: { token: first } }));
    expect(attached >>> 0).toBeGreaterThanOrEqual(BACKEND);
    expect(count(sender.send({ Withdraw: { token: first } }))).toBe(0);
    expect(errorText(receiver.send({ AttachMemory: { token: first } }))).toContain("BadF");
    expect(errorText(sender.send({ Withdraw: { token: first } }))).toContain("BadF");
    const second = count(sender.send({ PublishMemory: { memory } }));
    expect(second).toBe(0xffffffff);
    expect(errorText(sender.send({ PublishMemory: { memory } }))).toContain("Again");
  });

  test("only the publishing incarnation withdraws, and a token from another group names nothing", () => {
    const { join } = group();
    const sender = join(), peer = join(sender), foreign = join();
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    const token = count(sender.send({ PublishMemory: { memory } }));
    expect(errorText(peer.send({ Withdraw: { token } }))).toContain("BadF");
    expect(errorText(foreign.send({ AttachMemory: { token } }))).toContain("BadF");
    expect(sender.owner.snapshot().published).toBe(1);
  });

  const refusals: readonly [string, (member: Member) => number][] = [
    ["a maximum beyond wasm32", member => forgedMemory(member, PAGE, 0xffffffff)],
    ["a reservation that disagrees with its maximum", member => forgedMemory(member, 2 * PAGE, 1)],
    ["a corrupted page count", member => forgedMemory(member, PAGE, 1, cells => { cells[0] = -1; })],
    ["a nonzero reserved cell word", member => forgedMemory(member, PAGE, 1, cells => { cells[3] = 9; })],
    ["a memory with no page cell", member => {
      const [, data] = member.raw(GroupOp.CREATE, PAGE, PAGE);
      return member.raw(GroupOp.PUBLISH, MEMORY_PUBLICATION, data!, 0, 1)[1]!;
    }],
    ["a page cell that is too short", member => {
      const [, data] = member.raw(GroupOp.CREATE, PAGE, PAGE);
      const [, cell] = member.raw(GroupOp.CREATE, 8, 8);
      return member.raw(GroupOp.PUBLISH, MEMORY_PUBLICATION, data!, cell!, 1)[1]!;
    }],
  ];
  for (const [name, publish] of refusals) test(`refuses ${name} and keeps no hold`, () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const token = publish(sender);
    const before = counters(sender.owner);
    expect(receiver.send({ AttachMemory: { token } })).toHaveProperty("Error");
    expect(counters(sender.owner)).toEqual(before);
  });

  test("a full local table refuses before the owner takes a hold", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    const token = count(sender.send({ PublishMemory: { memory } }));
    Reflect.get(Reflect.get(receiver.host, "regions"), "slots").length = MAX_RESOURCES;
    const before = counters(sender.owner);
    expect(errorText(receiver.send({ AttachMemory: { token } }))).toContain("nested resource limit");
    expect(counters(sender.owner)).toEqual(before);
  });

  test("a corrupted cell fails later reads rather than widening access", () => {
    const { join } = group();
    const member = join();
    const memory = handle(member.send({ Reserve: { initial: 1, maximum: 1 } }));
    const region = Reflect.get(member.host, "regions").get(memory);
    Atomics.store(Reflect.get(region, "cells") as Int32Array, 0, 2);
    expect(member.send({ Span: { memory } })).toEqual({ Error: { category: "RuntimeError", message: "nested execution failed: nested memory page count is corrupt" } });
  });
});

describe("published modules", () => {
  test("a description round trips exactly and the receiver compiles its own copy", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const module = compileLocal(sender);
    const text = '{"memory":{"note":"\\"I64\\":5 é"},"imports":[],"exports":[]}';
    const held = sender.owner.snapshot().holds;
    const token = count(sender.send({ PublishModule: { module, description: text } }));
    expect(sender.owner.snapshot().holds).toBe(held);
    const reply = receiver.send({ AttachModule: { token } }) as ReplyOf<"AttachedModule">;
    expect(reply.AttachedModule.description).toBe(text);
    expect(reply.AttachedModule.id >>> 0).toBeGreaterThanOrEqual(BACKEND);
    expect(sender.owner.snapshot().holds).toBe(held);
    expect(errorText(receiver.send({ PublishModule: { module: reply.AttachedModule.id, description: text } }))).toContain("compiled by this member");
  });

  const refusals: readonly [string, (member: Member) => number][] = [
    ["a description past its extent", member => forgedModule(member, description, emptyModule, 0x7fffffff)],
    ["a description that consumes the extent", member => forgedModule(member, description, emptyModule, description.length + emptyModule.length)],
    ["invalid UTF-8", member => forgedModule(member, Uint8Array.from([0xff, 0xfe, 0x7b, 0x7d]), emptyModule)],
    ["invalid JSON", member => forgedModule(member, encoder.encode("{not json"), emptyModule)],
    ["a description of the wrong shape", member => forgedModule(member, encoder.encode('{"memory":{}}'), emptyModule)],
    ["bytes that do not compile", member => forgedModule(member, description, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))],
  ];
  for (const [name, publish] of refusals) test(`refuses ${name} and keeps no hold`, () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const token = publish(sender);
    const before = counters(sender.owner);
    expect(receiver.send({ AttachModule: { token } })).toHaveProperty("Error");
    expect(counters(sender.owner)).toEqual(before);
    const good = forgedModule(sender, description, emptyModule);
    expect(receiver.send({ AttachModule: { token: good } })).toHaveProperty("AttachedModule");
  });

  test("attachment keeps the global refusal that Compile has, and admits a table export as Compile does", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const token = forgedModule(sender, description, globalModule);
    const before = counters(sender.owner);
    expect(errorText(receiver.send({ AttachModule: { token } }))).toBe("Nested globals are not available on the Browser host");
    expect(counters(sender.owner)).toEqual(before);
    expect(receiver.host.snapshot().modules).toBe(0);
    const admitted = forgedModule(sender, description, tableModule);
    expect(receiver.send({ AttachModule: { token: admitted } })).toHaveProperty("AttachedModule");
    expect(receiver.host.snapshot().modules).toBe(1);
  });

  test("the owner decides kind before any byte is read", () => {
    const { join } = group();
    const sender = join(), receiver = join(sender);
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    const token = count(sender.send({ PublishMemory: { memory } }));
    const before = counters(sender.owner);
    expect(errorText(receiver.send({ AttachModule: { token } }))).toContain("BadF");
    expect(counters(sender.owner)).toEqual(before);
  });
});

describe("retirement", () => {
  test("a publication outlives its sender, and a retained end holds nothing", () => {
    const { groups, join } = group();
    const sender = join(), receiver = join(sender);
    const owner = sender.owner;
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    const token = count(sender.send({ PublishMemory: { memory } }));
    sender.lease.stopped();
    expect(owner.snapshot().published).toBe(1);
    expect(receiver.send({ AttachMemory: { token } })).toHaveProperty("Handle");
    receiver.lease.stopped();
    const { regions, holds, pins, watches, published } = owner.snapshot();
    expect({ regions, holds, pins, watches, published }).toEqual({ regions: 0, holds: 0, pins: 0, watches: 0, published: 0 });
    expect(groups.snapshot()).toEqual([]);
    expect(groups.budget.committed).toBe(0);
  });

  test("a failed stop stays debt until it settles", () => {
    const { groups, join } = group();
    const sender = join(), other = join(sender);
    const owner = sender.owner;
    const memory = handle(sender.send({ Reserve: { initial: 1, maximum: 1 } }));
    count(sender.send({ PublishMemory: { memory } }));
    sender.lease.stopped();
    const charged = groups.budget.committed;
    other.lease.failed();
    expect(owner.snapshot().retained).toBe(1);
    expect(owner.snapshot().published).toBe(1);
    expect(groups.budget.committed).toBe(charged);
    expect(groups.snapshot()).toHaveLength(1);
    other.lease.stopped();
    expect(owner.snapshot().published).toBe(0);
    expect(groups.budget.committed).toBe(0);
  });
});
