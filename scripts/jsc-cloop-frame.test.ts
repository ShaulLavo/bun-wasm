import { expect, test } from "bun:test";
import { cloopFrame, cloopFrameFindings, cloopFrameFloor, cloopValueSlotCeiling } from "./jsc-cloop-frame.ts";

// A side with an imported callee and the interpreter function under test. Global 0 is the
// imported, exported stack pointer, as wasm-ld lays out a PIC side. Locals 0 and 1 hold the two
// entry allocations, 2 and 3 are spare frame locals, and 4 is an ordinary i32.
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
const add = [0x6a];
const subtract = [0x6b];
const drop = [0x1a];
const allocate = (bytes: number, local: number): number[] => globalGet(0).concat(constant(bytes), subtract, localTee(local), globalSet(0));
const release = (bytes: number, local: number): number[] => localGet(local).concat(constant(bytes), add, globalSet(0));
// The same two writes as compilers emit them when the negated constant is shorter.
const allocateFolded = (bytes: number, local: number): number[] => globalGet(0).concat(constant(-bytes), add, localTee(local), globalSet(0));
const releaseFolded = (bytes: number, local: number): number[] => localGet(local).concat(constant(-bytes), subtract, globalSet(0));
const call = [0x10, 0];
const end = [0x0b];
const block = (body: number[]): number[] => [0x02, 0x40].concat(body, end);
const loop = (body: number[]): number[] => [0x03, 0x40].concat(body, end);
const when = (body: number[], otherwise?: number[]): number[] => localGet(4).concat([0x04, 0x40], body, otherwise ? [0x05].concat(otherwise) : [], end);
const branchIf = (depth: number): number[] => localGet(4).concat([0x0d, depth]);
const branchTable = (depths: number[], fallback: number): number[] => localGet(4).concat([0x0e], leb(depths.length), depths, [fallback]);

interface SideOptions { names?: string[]; exportStackPointer?: boolean; locals?: number }

function side(body: number[], { names = [interpreter], exportStackPointer = true, locals = 5 }: SideOptions = {}): Uint8Array<ArrayBuffer> {
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

const accepted: ReadonlyArray<readonly [string, number[], { retainedBytes: number; deepestBytes: number; calls: number }]> = [
  ["the split build's shape", framed(call), { retainedBytes: 4896, deepestBytes: 4896, calls: 1 }],
  ["an inlined callee's own frame", framed(allocate(32, 2).concat(allocate(16, 3), call, release(16, 3), release(32, 2), call)), { retainedBytes: 4896, deepestBytes: 4944, calls: 2 }],
  ["allocations written with a negated constant", framed(allocateFolded(64, 2).concat(call, releaseFolded(64, 2), call)), { retainedBytes: 4896, deepestBytes: 4960, calls: 2 }],
  ["a loop that allocates and releases on every pass", framed(loop(call.concat(allocate(16, 2), call, release(16, 2), branchIf(0)))), { retainedBytes: 4896, deepestBytes: 4912, calls: 2 }],
  ["a frame in one arm of an if", framed(when(allocate(48, 2).concat(call, release(48, 2)), call).concat(call)), { retainedBytes: 4896, deepestBytes: 4944, calls: 3 }],
  ["a branch table out of nested blocks", framed(block(block(branchTable([0, 1], 1).concat(call)).concat(call)).concat(call)), { retainedBytes: 4896, deepestBytes: 4896, calls: 2 }],
  ["a frame local reused for another value after its release", framed(allocate(32, 2).concat(call, release(32, 2), constant(7), localTee(2), drop, call)), { retainedBytes: 4896, deepestBytes: 4928, calls: 2 }],
];

for (const [name, body, frame] of accepted) {
  test(`measures ${name}`, () => {
    const bytes = side(body);
    expect(() => new WebAssembly.Module(bytes)).not.toThrow();
    const measured = cloopFrame(bytes);
    expect(measured).toMatchObject(frame);
    expect(cloopFrameFindings(measured)).toEqual([]);
  });
}

test("a frame below the floor fails, and so does the measured frame against a higher threshold", () => {
  const smaller = cloopFrame(side(framed(call, [80, 4800])));
  expect(cloopFrameFindings(smaller)).toEqual(["CLoop::execute holds 4880 guarded bytes at one of its calls, below the 4896-byte floor"]);
  const exact = cloopFrame(side(framed(call)));
  expect(cloopFrameFindings(exact, { floor: cloopFrameFloor + 16, valueSlotCeiling: cloopValueSlotCeiling })).toHaveLength(1);
});

test("more wasm locals than the ceiling fail", () => {
  const frame = cloopFrame(side(framed(call), { locals: cloopValueSlotCeiling + 1 }));
  expect(cloopFrameFindings(frame)).toEqual([`CLoop::execute has ${cloopValueSlotCeiling + 1} wasm parameters and locals, above the ceiling of ${cloopValueSlotCeiling}`]);
});

// Shapes whose frame is released, or not yet allocated, on some path to a call.
const shallow: ReadonlyArray<readonly [string, number[], number]> = [
  ["a call before the entry allocations", call.concat(allocate(4896, 0), release(4896, 0), end), 0],
  ["a release in the middle, before a call", framed(release(4816, 1).concat(call)), 80],
  ["an allocation that comes after a call", allocate(80, 0).concat(call, allocate(4816, 1), release(4816, 1), release(80, 0), end), 80],
  ["a release in one arm of an if, before a call", framed(when(release(4816, 1)).concat(call)), 80],
  ["a branch that skips an allocation", allocate(80, 0).concat(block(branchIf(0).concat(allocate(4816, 1), call)), call, release(80, 0), end), 80],
  ["a loop whose later passes arrive released", framed(loop(call.concat(release(4816, 1), branchIf(0)))), 80],
  ["a branch table taken after a release", framed(block(block(release(4816, 1).concat(branchTable([0], 1))).concat(call))), 80],
];

for (const [name, body, retainedBytes] of shallow) {
  test(`finds ${name}`, () => {
    const frame = cloopFrame(side(body));
    expect(frame.retainedBytes).toBe(retainedBytes);
    expect(cloopFrameFindings(frame)).toHaveLength(1);
  });
}

const rejected: ReadonlyArray<readonly [string, Uint8Array, string]> = [
  ["a release through a local that was written again", side(framed(globalGet(1).concat(localTee(1), drop, call))), "released through local 1, which holds no known allocation"],
  ["a release through a local a loop pass overwrites", side(framed(allocate(32, 2).concat(loop(call.concat(release(32, 2), constant(0), localTee(2), drop, branchIf(0)))))), "released through local 2, which holds no known allocation"],
  ["a dynamic allocation", side(framed(globalGet(0).concat(localGet(4), subtract, globalSet(0), call))), "written in an unrecognized way"],
  ["a stack pointer restored from a plain local", side(framed(call.concat(localGet(2), globalSet(0)))), "written in an unrecognized way"],
  ["an allocation that is not aligned", side(allocate(4900, 0).concat(call, release(4900, 0), end)), "unexpected stack allocation of 4900 bytes"],
  ["an allocation that moves the stack pointer up", side(framed(allocate(-32, 2).concat(call))), "unexpected stack allocation of -32 bytes"],
  ["a tail call", side(framed([0x12, 0])), "makes a tail call"],
  ["no call at all", side(framed([])), "makes no call"],
  ["no exported stack pointer", side(framed(call), { exportStackPointer: false }), "does not export __stack_pointer"],
  ["no interpreter function", side(framed(call), { names: ["JSC::LLInt::CLoop::other()"] }), "found 0"],
  ["two interpreter functions", side(framed(call), { names: [interpreter, interpreter] }), "found 2"],
  ["an instruction the reader does not know", side(framed([0x06, 0x40, 0x0b].concat(call))), "unknown opcode 0x6"],
  ["a truncated body", side(framed(call).slice(0, -1)), "does not end with `end`"],
  ["an unclosed block", side(framed([0x02, 0x40].concat(call))), "does not end with `end`"],
];

for (const [name, bytes, message] of rejected) {
  test(`rejects ${name}`, () => {
    expect(() => cloopFrame(bytes)).toThrow(message);
  });
}

test("the command fails closed on a rejected side and on a low frame", async () => {
  const scratch = `${process.env.TMPDIR ?? "/tmp"}/bun-wasm-cloop-frame-${process.pid}`;
  const cases: ReadonlyArray<readonly [string, Uint8Array, number]> = [
    ["accepted.wasm", side(framed(call)), 0], ["low.wasm", side(framed(call, [80, 4800])), 1],
    ["shape.wasm", side(framed(globalGet(0).concat(localGet(4), subtract, globalSet(0), call))), 1],
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
