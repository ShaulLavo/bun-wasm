import { expect, test } from "bun:test";
import { cloopFrame, cloopFrameFindings, cloopFrameFloor, cloopValueSlotCeiling } from "./jsc-cloop-frame.ts";

// A two-function side: an imported callee, then the interpreter function under test. Global 0 is
// the imported, exported stack pointer, as wasm-ld lays out a PIC side.
const interpreter = "JSC::LLInt::CLoop::execute(JSC::OpcodeID, void*, JSC::VM*, JSC::ProtoCallFrame*, bool)";
const text = (value: string): number[] => leb(value.length).concat(Array.from(new TextEncoder().encode(value)));

function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value);
  return bytes;
}

function signed(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && !(byte & 0x40)) || (value === -1 && !!(byte & 0x40));
    bytes.push(done ? byte : byte | 0x80);
    if (done) return bytes;
  }
}

const section = (id: number, payload: number[]): number[] => [id].concat(leb(payload.length), payload);
const globalGet = (index: number): number[] => [0x23, index];
const globalSet = (index: number): number[] => [0x24, index];
const localGet = (index: number): number[] => [0x20, index];
const localTee = (index: number): number[] => [0x22, index];
const constant = (value: number): number[] => [0x41].concat(signed(value));
const allocate = (bytes: number, local: number): number[] => globalGet(0).concat(constant(bytes), [0x6b], localTee(local), globalSet(0));
const release = (bytes: number, local: number): number[] => localGet(local).concat(constant(bytes), [0x6a], globalSet(0));
const call = [0x10, 0];
const end = [0x0b];

interface SideOptions { names?: string[]; exportStackPointer?: boolean; locals?: number }

function side(body: number[], { names = [interpreter], exportStackPointer = true, locals = 4 }: SideOptions = {}): Uint8Array {
  const code = [1].concat(leb(locals), [0x7f], body);
  const functionNames = names.flatMap((name, position) => leb(position + 1).concat(text(name)));
  const nameSection = text("name").concat([1], leb(leb(names.length).length + functionNames.length), leb(names.length), functionNames);
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(
    section(1, [1, 0x60, 0, 0]),
    section(2, [2].concat(text("env"), text("__stack_pointer"), [3, 0x7f, 1], text("env"), text("callee"), [0, 0])),
    section(3, leb(names.length).concat(names.map(() => 0))),
    exportStackPointer ? section(7, [1].concat(text("__stack_pointer"), [3, 0])) : [],
    section(10, leb(names.length).concat(names.flatMap(() => leb(code.length).concat(code)))),
    section(0, nameSection)));
}

const framed = (inside: number[], sizes: readonly [number, number] = [80, 4816]): number[] =>
  allocate(sizes[0], 0).concat(allocate(sizes[1], 1), inside, release(sizes[1], 1), release(sizes[0], 0), end);

test("the accepted shape is a valid module and measures the whole frame", () => {
  const bytes = side(framed(call));
  expect(() => new WebAssembly.Module(bytes)).not.toThrow();
  const frame = cloopFrame(bytes);
  expect(frame).toMatchObject({ retainedBytes: 4896, allocations: [80, 4816], parameters: 0, locals: 4, valueSlots: 4 });
  expect(cloopFrameFindings(frame)).toEqual([]);
});

test("a frame below the floor fails, and so does the real floor against a higher threshold", () => {
  const smaller = cloopFrame(side(framed(call, [80, 4800])));
  expect(smaller.retainedBytes).toBe(4880);
  expect(cloopFrameFindings(smaller)).toEqual(["CLoop::execute keeps 4880 guarded bytes, below the 4896-byte floor"]);
  const exact = cloopFrame(side(framed(call)));
  expect(cloopFrameFindings(exact, { floor: cloopFrameFloor + 16, valueSlotCeiling: cloopValueSlotCeiling })).toHaveLength(1);
});

test("more wasm locals than the ceiling fail", () => {
  const frame = cloopFrame(side(framed(call), { locals: cloopValueSlotCeiling + 1 }));
  expect(cloopFrameFindings(frame)).toEqual([`CLoop::execute has ${cloopValueSlotCeiling + 1} wasm parameters and locals, above the ceiling of ${cloopValueSlotCeiling}`]);
});

const rejected: ReadonlyArray<readonly [string, Uint8Array, string]> = [
  ["a release in the middle, before a call", side(framed(release(4816, 1).concat(call))), "written 5 times"],
  ["a second allocation after a call", side(allocate(80, 0).concat(call, allocate(4816, 1), release(4816, 1), release(80, 0), end)), "written 4 times"],
  ["no allocation at entry", side(call.concat(allocate(4896, 0), release(4896, 0), end)), "does not open with a stack allocation"],
  ["a release that is not last", side(allocate(4896, 0).concat(release(4896, 0), call, end)), "not released at the function's end"],
  ["a release of fewer bytes", side(allocate(4896, 0).concat(call, release(4880, 0), end)), "not released at the function's end"],
  ["a frame local written again", side(framed(globalGet(1).concat(localTee(1), [0x1a], call))), "frame local 1 is assigned 2 times"],
  ["a dynamic allocation", side(framed(globalGet(0).concat(localGet(2), [0x6b], globalSet(0)))), "written 5 times"],
  ["an extra stack pointer read", side(framed(globalGet(0).concat([0x1a]))), "read 3 times"],
  ["an allocation that is not aligned", side(allocate(4900, 0).concat(call, release(4900, 0), end)), "unexpected stack allocation of 4900 bytes"],
  ["one local for two allocations", side(allocate(80, 0).concat(allocate(4816, 0), call, release(4816, 0), release(80, 0), end)), "frame local 0 is assigned 2 times"],
  ["no exported stack pointer", side(framed(call), { exportStackPointer: false }), "does not export __stack_pointer"],
  ["no interpreter function", side(framed(call), { names: ["JSC::LLInt::CLoop::other()"] }), "found 0"],
  ["two interpreter functions", side(framed(call), { names: [interpreter, interpreter] }), "found 2"],
  ["an instruction the reader does not know", side(framed([0x06, 0x40, 0x0b])), "unknown opcode 0x6"],
  ["a truncated body", side(framed(call).slice(0, -1)), "does not end with `end`"],
];

for (const [name, bytes, message] of rejected) {
  test(`rejects ${name}`, () => {
    expect(() => cloopFrame(bytes)).toThrow(message);
  });
}

test("the command fails closed on a rejected side and on a low frame", async () => {
  const scratch = `${process.env.TMPDIR ?? "/tmp"}/bun-wasm-cloop-frame-${process.pid}`;
  const cases: ReadonlyArray<readonly [string, Uint8Array, number]> = [
    ["accepted.wasm", side(framed(call)), 0], ["low.wasm", side(framed(call, [80, 4800])), 1], ["shape.wasm", side(framed(release(4816, 1).concat(call))), 1],
  ];
  try {
    for (const [file, bytes, status] of cases) {
      await Bun.write(`${scratch}/${file}`, bytes);
      const run = Bun.spawnSync(["bun", `${import.meta.dir}/jsc-cloop-frame.ts`, "check", `${scratch}/${file}`], { stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(status);
      expect(JSON.parse(run.stdout.toString()).findings.length === 0).toBe(status === 0);
    }
  } finally {
    Bun.spawnSync(["rm", "-rf", "--", scratch]);
  }
});
