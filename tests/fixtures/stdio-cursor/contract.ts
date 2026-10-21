import assert from "node:assert/strict";

type Callback = (error?: Error | null) => void;
export interface CursorWriter {
  write(chunk: string, callback?: Callback): boolean;
  clearLine(direction: number, callback?: Callback): boolean;
  clearScreenDown(callback?: Callback): boolean;
  cursorTo(x?: number, y?: number | Callback, callback?: Callback): boolean;
  moveCursor(dx: number, dy: number, callback?: Callback): boolean;
}

const cases: { call: (stream: CursorWriter, callback?: Callback) => boolean; bytes: string }[] = [
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

export const cursorBytes = cases.map(entry => entry.bytes).join("");

function verifyCase(stream: CursorWriter, entry: typeof cases[number], returned: boolean) {
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
    for (const entry of cases) {
      verifyCase(stream, entry, false);
      verifyCase(stream, entry, true);
    }
  } finally { stream.write = write; }
}

export async function emitCursorSequence(stream: CursorWriter) {
  const order: string[] = [];
  const returned = cases.map((entry, index) => entry.call(stream, error => {
    assert.equal(error, null);
    order.push(`callback ${index}`);
  }));
  order.push("returned");
  assert.deepEqual(returned, cases.map(() => true));
  assert.deepEqual(order, ["returned"]);
  await new Promise<void>(resolve => process.nextTick(resolve));
  assert.deepEqual(order, ["returned"].concat(cases.map((_, index) => `callback ${index}`)));
}

export async function verifyNoop(stream: CursorWriter) {
  const write = stream.write;
  const order: string[] = [];
  stream.write = () => { throw new Error("zero movement must not write"); };
  try {
    assert.equal(stream.moveCursor(0, 0, error => { assert.equal(error, null); order.push("callback"); }), true);
    assert.equal(stream.cursorTo(undefined, undefined, error => { assert.equal(error, null); order.push("cursor callback"); }), true);
    order.push("returned");
    assert.deepEqual(order, ["returned"]);
    await new Promise<void>(resolve => process.nextTick(resolve));
    assert.deepEqual(order, ["returned", "callback", "cursor callback"]);
  } finally { stream.write = write; }
}
