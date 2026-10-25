import assert from "node:assert/strict";

export type Callback = (error?: Error | null) => void;
export interface CursorWriter {
  write(chunk: string, callback?: Callback): boolean;
  clearLine(direction: number, callback?: Callback): boolean;
  clearScreenDown(callback?: Callback): boolean;
  cursorTo(x?: number, y?: number | Callback, callback?: Callback): boolean;
  moveCursor(dx: number, dy: number, callback?: Callback): boolean;
}

export const cursorCases: { call: (stream: CursorWriter, callback?: Callback) => boolean; bytes: string }[] = [
  { call: (s, cb) => s.clearLine(-1, cb), bytes: "\x1b[1K" },
  { call: (s, cb) => s.clearLine(0, cb), bytes: "\x1b[2K" },
  { call: (s, cb) => s.clearLine(1, cb), bytes: "\x1b[0K" },
  { call: (s, cb) => s.clearScreenDown(cb), bytes: "\x1b[0J" },
  { call: (s, cb) => s.cursorTo(0, cb), bytes: "\x1b[1G" },
  { call: (s, cb) => s.cursorTo(2, 3, cb), bytes: "\x1b[4;3H" },
  { call: (s, cb) => s.moveCursor(-2, 3, cb), bytes: "\x1b[2D\x1b[3B" },
  { call: (s, cb) => s.moveCursor(2, -3, cb), bytes: "\x1b[2C\x1b[3A" },
  { call: (s, cb) => s.moveCursor(0, -1, cb), bytes: "\x1b[1A" },
  { call: (s, cb) => s.moveCursor(1, 0, cb), bytes: "\x1b[1C" },
];

export const cursorBytes = cursorCases.map(entry => entry.bytes).join("");

function verifyCase(stream: CursorWriter, entry: typeof cursorCases[number], returned: boolean) {
  const callback: Callback = () => { throw new Error("intercepted write must own its callback"); };
  const writes: [string, Callback | undefined][] = [];
  stream.write = (chunk, cb) => { writes.push([chunk, cb]); return returned; };
  assert.equal(entry.call(stream, callback), returned);
  assert.deepEqual(writes, [[entry.bytes, callback]]);
  writes.length = 0;
  assert.equal(entry.call(stream), returned);
  assert.deepEqual(writes, [[entry.bytes, undefined]]);
}

export function verifyDelegation(stream: CursorWriter) {
  const write = stream.write;
  try {
    for (const entry of cursorCases) {
      verifyCase(stream, entry, false);
      verifyCase(stream, entry, true);
    }
  } finally { stream.write = write; }
}

export async function verifyNoop(stream: CursorWriter) {
  const write = stream.write;
  const order: string[] = [];
  stream.write = () => { throw new Error("zero movement must not write"); };
  try {
    assert.equal(stream.moveCursor(0, 0), true);
    assert.equal(stream.cursorTo(), true);
    assert.equal(stream.moveCursor(0, 0, error => { assert.equal(error, null); order.push("callback"); }), true);
    assert.equal(stream.cursorTo(undefined, undefined, error => { assert.equal(error, null); order.push("cursor callback"); }), true);
    order.push("returned");
    assert.deepEqual(order, ["returned"]);
    await new Promise<void>(resolve => process.nextTick(resolve));
    assert.deepEqual(order, ["returned", "callback", "cursor callback"]);
  } finally { stream.write = write; }
}

export function verifyValidation(stream: CursorWriter) {
  assert.throws(() => stream.cursorTo(NaN), { code: "ERR_INVALID_ARG_VALUE" });
  assert.throws(() => stream.cursorTo(0, NaN), { code: "ERR_INVALID_ARG_VALUE" });
  assert.throws(() => stream.cursorTo(undefined, 1), { code: "ERR_INVALID_CURSOR_POS" });
  const invalid: [Function, unknown[]][] = [
    [stream.clearLine, [0, null]], [stream.clearScreenDown, [null]],
    [stream.cursorTo, [0, 0, null]], [stream.cursorTo, [0, () => {}, null]],
    [stream.moveCursor, [0, 0, null]],
  ];
  for (const [method, args] of invalid) {
    assert.throws(() => Reflect.apply(method, stream, args), {
      code: "ERR_INVALID_ARG_TYPE",
      message: 'The "callback" argument must be of type function. Received null',
    });
  }
}

function verifyAxisCoercion(stream: CursorWriter, axis: "x" | "y") {
  let conversions = 0;
  const distance = { valueOf() { return ++conversions === 1 ? -1 : 1; } };
  const callback: Callback = () => { throw new Error("write owns callback"); };
  const writes: [string, Callback | undefined][] = [];
  stream.write = (chunk, cb) => { writes.push([chunk, cb]); return false; };
  const args = axis === "x" ? [distance, 0, callback] : [0, distance, callback];
  assert.equal(Reflect.apply(stream.moveCursor, stream, args), false);
  assert.deepEqual(writes, [[axis === "x" ? "\x1b[-1D" : "\x1b[-1A", callback]]);
  assert.equal(conversions, 2);
}

export function verifyCoercion(stream: CursorWriter) {
  const write = stream.write;
  try {
    verifyAxisCoercion(stream, "x");
    verifyAxisCoercion(stream, "y");
  } finally { stream.write = write; }
}

if (import.meta.main) {
  const { WriteStream } = await import("node:tty");
  const streams = process.versions.bun ? [process.stdout, process.stderr] : [new WriteStream(1), new WriteStream(2)];
  for (const stream of streams) {
    verifyDelegation(stream);
    verifyCoercion(stream);
    await verifyNoop(stream);
    verifyValidation(stream);
  }
  console.log(`PASS ${process.versions.bun ? "Bun " + process.versions.bun : "Node " + process.version} stdio cursor reference`);
}
