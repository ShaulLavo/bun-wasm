// The guest's declared 2 GiB address space and 1 GiB member cap on the Browser host
// (docs/memory-ceiling.md, stage 2), through the adapters a page uses: Waffle's group owner under
// BUN_MEMORY_GROUP_POLICY, the real NestedHost, and Waffle's preview1 over the group memory.
// The last valid byte is 0x7fffffff. 0x80000000 is a legal one-past-end address and nothing more.
import { describe, expect, test } from "bun:test";
import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { GroupErrno, GroupOp } from "../node_modules/waffle/group/protocol.ts";
import { BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind.ts";
import { PAGE, counters, errorText, group, handle, type Member, type Owner, type ReplyOf } from "./nested-host-owner";

const END = 0x8000_0000;
const declarationPolicy = { ...BUN_MEMORY_GROUP_POLICY, maximumPages: 32768 };
const NOMEM = -GroupErrno.NOMEM;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Groups = ReturnType<typeof group>["groups"];

function grow(member: Member, pages: number): number { return member.raw(GroupOp.GROW, pages)[0]!; }
function bytes(member: Member, pointer: number, length: number) { return new Uint8Array(member.memory.buffer, pointer, length); }
function view(member: Member) { return new DataView(member.memory.buffer); }
/** Pages members hold now, as the owner reports them. */
function memberPages(owner: Owner) { return owner.snapshot().memberPages; }

/** Everything a refusal must leave as it was: owner tables, both charges, the free list, the host. */
function ledger(member: Member, groups: Groups) {
  const { committedBytes, freeBytes, members, retained } = member.owner.snapshot();
  return { ...counters(member.owner), committedBytes, freeBytes, members, retained, memberPages: memberPages(member.owner),
    budget: groups.budget.committed, host: member.host.snapshot() };
}

/** One nested request whose bytes sit at `pointer` and whose reply cell is the eight bytes at `out`. */
function request(member: Member, text: string, pointer: number, out: number): unknown {
  const encoded = encoder.encode(text);
  bytes(member, pointer, encoded.length).set(encoded);
  member.host.imports.request(pointer, encoded.length, out);
  const target = view(member).getUint32(out, true);
  return JSON.parse(decoder.decode(bytes(member, target, view(member).getUint32(out + 4, true)).slice()));
}

/** Waffle's preview1 `fd_write` over the group memory, with one iovec placed at `iovec`. */
function write(member: Member, wasi: Wasi, iovec: number, span: readonly [number, number], cell: number): number {
  view(member).setUint32(iovec, span[0], true);
  view(member).setUint32(iovec + 4, span[1], true);
  // A core passes addresses as i32: 0x80000000 and above arrive negative.
  return wasi.fdWrite(1, iovec | 0, 1, cell | 0);
}

describe("the Bun group policy", () => {
  test("keeps experimental backing below declarations with the 1 GiB member cap", () => {
    expect(BUN_MEMORY_GROUP_POLICY).toEqual({ maximumPages: 20480, memberPages: 16384, stackBytes: 8 << 20 });
    expect(declarationPolicy.maximumPages * PAGE).toBe(END);
  });
});

describe("a Bun group filled to its 2 GiB end", () => {
  test("holds stock Rolldown's memory beside its member, serves the final byte and refuses one page more", () => {
    const { groups, join } = group(declarationPolicy);
    const member = join();
    const output: string[] = [];
    const diagnostics: string[] = [];
    const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout: data => { output.push(decoder.decode(data)); },
      stderr: data => { diagnostics.push(decoder.decode(data)); }, sleep() {} });
    wasi.bindMemory(member.memory);
    try {
      // A member always holds pages before its program can ask for a memory.
      expect(grow(member, 1)).toBeGreaterThan(0);
      // Stock Rolldown's descriptor: the declared maximum cannot fit, so it takes its initial
      // pages and the preferred growth room, and a second one is refused whole.
      const rolldown = handle(member.send({ Reserve: { initial: 16384, maximum: 65536 } }));
      const span = () => (member.send({ Span: { memory: rolldown } }) as ReplyOf<"Memory">).Memory;
      expect(span()).toMatchObject({ pages: 16384, maximum: 65536, committed: 17408 * PAGE });
      const admitted = ledger(member, groups);
      expect(errorText(member.send({ Reserve: { initial: 16384, maximum: 65536 } }))).toBe("region admission: NoMem");
      expect(ledger(member, groups)).toEqual(admitted);
      const top = span().pointer + 16384 * PAGE;
      bytes(member, top - 1, 1)[0] = 7;
      expect(Array.from(bytes(member, top - 1, 2))).toEqual([7, 0]);

      // The member takes every page that is left; its last chunk ends at the end of the group.
      const rest = declarationPolicy.maximumPages - member.owner.snapshot().committedBytes / PAGE;
      expect(rest).toBeGreaterThan(8192);
      const heap = grow(member, rest);
      expect(heap * PAGE).toBeGreaterThan(2 ** 30);
      expect((heap + rest) * PAGE).toBe(END);
      expect(member.memory.buffer.byteLength).toBe(END);
      expect(member.owner.snapshot().committedBytes).toBe(END);
      expect(groups.budget.committed).toBe(END);

      // The final byte, and views that would pass it.
      bytes(member, END - 1, 1)[0] = 0xa5;
      expect(bytes(member, END - 1, 1)[0]).toBe(0xa5);
      expect(() => bytes(member, END - 1, 2)).toThrow(RangeError);
      expect(() => bytes(member, END, 1)).toThrow(RangeError);

      // NestedHost: a request whose bytes end at the final byte, and a reply cell in the final eight bytes.
      const text = JSON.stringify({ Span: { memory: rolldown } });
      const cell = END - PAGE;
      expect(request(member, text, END - text.length, cell)).toEqual({ Memory: span() });
      expect(request(member, text, END - PAGE + 64, END - 8)).toEqual({ Memory: span() });
      // Spans that reach past the end are refused before anything is decoded or stored.
      const before = ledger(member, groups);
      view(member).setUint32(cell, 0x1234_5678, true);
      for (const [pointer, length, out] of [[END - 4, 8, cell], [END, 1, cell], [0xffff_fff0, 0x20, cell], [END - PAGE + 64, text.length, END - 4], [END - PAGE + 64, text.length, END]] as const) {
        expect(() => member.host.imports.request(pointer | 0, length, out | 0)).toThrow(RangeError);
      }
      expect(view(member).getUint32(cell, true)).toBe(0x1234_5678);
      expect(ledger(member, groups)).toEqual(before);

      // Waffle's preview1 over the same memory: bytes ending at the final byte, the iovec in the
      // final eight bytes, then the result cell in the final word.
      const iovec = END - PAGE + 0x100;
      bytes(member, END - 4, 4).set(encoder.encode("top!"));
      expect(write(member, wasi, iovec, [END - 4, 4], cell)).toBe(0);
      expect(view(member).getUint32(cell, true)).toBe(4);
      bytes(member, END - 16, 4).set(encoder.encode("edge"));
      expect(write(member, wasi, END - 8, [END - 16, 4], cell)).toBe(0);
      expect(write(member, wasi, iovec, [END - 16, 4], END - 4)).toBe(0);
      expect(view(member).getUint32(END - 4, true)).toBe(4);
      expect(output.join("")).toBe("top!edgeedge");
      // Invalid data spans and iovec arrays return an errno before emitting output.
      view(member).setUint32(cell, 0x1234_5678, true);
      for (const refused of [[END - 4, 5], [END - 1, 2], [END, 1], [0xffff_fff0, 0x20]] as const) {
        expect(write(member, wasi, iovec, refused, cell)).not.toBe(0);
      }
      view(member).setUint32(END - 4, END - 16, true);
      expect(wasi.fdWrite(1, END - 4, 1, cell)).not.toBe(0);
      expect(view(member).getUint32(cell, true)).toBe(0x1234_5678);
      expect(output.join("")).toBe("top!edgeedge");
      // Invalid result cells fail after valid data reaches stdout, without storing a partial result.
      const resultBoundary = ledger(member, groups);
      view(member).setUint32(END - 4, 0x1234_5678, true);
      for (const resultCell of [END - 3, END]) {
        const chunks = output.length;
        expect(write(member, wasi, iovec, [END - 16, 4], resultCell)).not.toBe(0);
        expect(output.slice(chunks).join("")).toBe("edge");
        expect(view(member).getUint32(END - 4, true)).toBe(0x1234_5678);
        expect(view(member).getUint32(cell, true)).toBe(0x1234_5678);
        expect(ledger(member, groups)).toEqual(resultBoundary);
      }
      expect(diagnostics.length).toBeGreaterThan(0);

      // One page over: neither a member page nor a region nor a memory is admitted, and nothing changes.
      const full = ledger(member, groups);
      expect(grow(member, 1)).toBe(NOMEM);
      expect(member.raw(GroupOp.CREATE, PAGE + 1, 16)[0]).toBe(NOMEM);
      expect(errorText(member.send({ Reserve: { initial: 1, maximum: 1 } }))).toBe("region admission: NoMem");
      expect(ledger(member, groups)).toEqual(full);
    } finally {
      member.lease.stopped();
    }
    expect(member.owner.snapshot()).toMatchObject({ members: 0, retained: 0, regions: 0, holds: 0, pins: 0, published: 0 });
    expect(groups.budget.committed).toBe(0);
  });
});

// The reviewed Waffle contract (waffle PR 478): `memberPages` counts every granted member chunk
// of every reserved, launched or retained member, and never a region.
describe("the cumulative member cap", () => {
  const capped = { maximumPages: 64, memberPages: 10 };

  test("an omitted cap is the configured maximum, and an explicit one cannot exceed it", () => {
    const custom = { maximumPages: 24 };
    const { join } = group(custom);
    const member = join();
    const rest = custom.maximumPages - member.owner.snapshot().committedBytes / PAGE;
    expect(grow(member, rest)).toBeGreaterThan(0);
    expect(memberPages(member.owner)).toBe(rest);
    expect(grow(member, 1)).toBe(NOMEM);
    member.lease.stopped();
    const beyond = { maximumPages: 24, memberPages: 25 };
    expect(() => group(beyond)).toThrow(RangeError);
  });

  test("two members jointly reach it, and a refused grow changes nothing", () => {
    const { groups, join } = group(capped);
    const first = join(), second = join(first);
    expect(grow(first, 6)).toBeGreaterThan(0);
    expect(grow(second, 4)).toBeGreaterThan(0);
    expect(memberPages(first.owner)).toBe(10);
    const before = ledger(first, groups);
    for (const member of [first, second]) {
      expect(grow(member, 1)).toBe(NOMEM);
      expect(grow(member, 11)).toBe(NOMEM);
    }
    expect(ledger(first, groups)).toEqual(before);
    // Released pages return to the cap and are reused from the free list, with no new backing.
    const committed = first.owner.snapshot().committedBytes;
    second.lease.stopped();
    expect(memberPages(first.owner)).toBe(6);
    expect(first.owner.snapshot().committedBytes).toBe(committed);
    expect(grow(first, 4)).toBeGreaterThan(0);
    expect(memberPages(first.owner)).toBe(10);
    expect(first.owner.snapshot().committedBytes).toBe(committed);
    expect(grow(first, 1)).toBe(NOMEM);
    first.lease.stopped();
    expect(groups.budget.committed).toBe(0);
  });

  test("regions are not counted and stay available at the cap", () => {
    const { join } = group(capped);
    const member = join();
    expect(grow(member, 10)).toBeGreaterThan(0);
    const before = member.owner.snapshot();
    expect(member.raw(GroupOp.CREATE, 3 * PAGE, 16)[0]).toBe(0);
    expect(handle(member.send({ Reserve: { initial: 2, maximum: 8 } }))).toBeGreaterThan(0);
    expect(memberPages(member.owner)).toBe(10);
    // Three region pages and an eight-page reservation, plus the host's own small regions.
    expect(member.owner.snapshot().committedBytes - before.committedBytes).toBeGreaterThanOrEqual(11 * PAGE);
    expect(grow(member, 1)).toBe(NOMEM);
    member.lease.stopped();
  });

  test("an aborted reservation returns nothing, and a retained member stays charged", () => {
    const { groups, join } = group(capped);
    const failed = join(), survivor = join(failed);
    expect(grow(failed, 7)).toBeGreaterThan(0);
    expect(grow(survivor, 3)).toBeGreaterThan(0);
    const reserved = groups.admit(99, "nested", failed.lease.group);
    reserved.abort();
    expect(memberPages(failed.owner)).toBe(10);
    failed.lease.failed();
    expect(failed.owner.snapshot()).toMatchObject({ retained: 1 });
    expect(memberPages(failed.owner)).toBe(10);
    expect(grow(survivor, 1)).toBe(NOMEM);
    failed.lease.stopped();
    expect(memberPages(survivor.owner)).toBe(3);
    expect(grow(survivor, 7)).toBeGreaterThan(0);
    survivor.lease.stopped();
    expect(groups.budget.committed).toBe(0);
  });
});
