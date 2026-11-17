import { extendedControls } from "./extended.ts";

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function throws(action: () => void, constructor: typeof Error): void {
  try {
    action();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`Expected ${constructor.name}`);
}

function boundsAndZeroing(): void {
  const buffer = new ArrayBuffer(16, { maxByteLength: 262144 });
  const tracking = new Uint8Array(buffer, 4);
  const fixed = new Uint8Array(buffer, 4, 8);
  const view = new DataView(buffer, 4, 8);
  tracking.fill(23);
  buffer.resize(6);
  equal([tracking.length, fixed.length, fixed.byteOffset], [2, 0, 0]);
  throws(() => view.getUint8(0), TypeError);
  buffer.resize(131073);
  equal([tracking.length, fixed.length, fixed.byteOffset, view.byteLength], [131069, 8, 4, 8]);
  equal(Array.from(fixed), [23, 23, 0, 0, 0, 0, 0, 0]);
  equal(tracking[131068], 0);
  tracking[131068] = 91;
  buffer.resize(65537);
  buffer.resize(131073);
  equal(tracking[131068], 0);
  buffer.resize(0);
  equal([tracking.length, fixed.length], [0, 0]);
  buffer.resize(16);
  equal(Array.from(new Uint8Array(buffer)), new Array(16).fill(0));
  throws(() => buffer.resize(262145), RangeError);
  throws(() => buffer.resize(2 ** 32 + 16), RangeError);
  equal(buffer.byteLength, 16);
}

function callbackGrowth(): void {
  const buffer = new ArrayBuffer(4, { maxByteLength: 262144 });
  const tracking = new Uint8Array(buffer);
  tracking.set([4, 3, 2, 1]);
  const visited: number[] = [];
  tracking.forEach((value, index) => {
    visited.push(value);
    if (index === 0) buffer.resize(65537);
  });
  equal(visited, [4, 3, 2, 1]);
  const fixed = new Uint8Array(buffer, 0, 4);
  fixed.sort((left, right) => {
    buffer.resize(131073);
    return left - right;
  });
  equal(Array.from(fixed), [1, 2, 3, 4]);
  fixed.set({ length: 2, get 0() { buffer.resize(196609); return 17; }, 1: 18 });
  equal(Array.from(fixed), [17, 18, 3, 4]);
  const data = new DataView(buffer);
  Reflect.apply(DataView.prototype.setUint8, data, [{ valueOf() { buffer.resize(262144); return 3; } }, 51]);
  equal(fixed[3], 51);
}

function maximumMetadata(): void {
  const empty = new ArrayBuffer(0, { maxByteLength: 0 });
  equal([empty.byteLength, empty.maxByteLength, empty.resizable], [0, 0, true]);
  empty.resize(0);
  // Eight 256 MiB maxima are twice the 1 GiB guest memory: only lazily backed maxima fit.
  const buffers = Array.from({ length: 8 }, () => new ArrayBuffer(0, { maxByteLength: 268435456 }));
  for (const buffer of buffers) {
    equal([buffer.byteLength, buffer.maxByteLength, buffer.resizable], [0, 268435456, true]);
    buffer.resize(1);
    equal(new Uint8Array(buffer)[0], 0);
  }
  throws(() => new ArrayBuffer(1, { maxByteLength: 2 ** 53 }), RangeError);
  throws(() => new ArrayBuffer(2, { maxByteLength: 1 }), RangeError);
}

function transferAndLifetime(): void {
  for (let index = 0; index < 32; index++) {
    const source = new ArrayBuffer(8, { maxByteLength: 131073 });
    const alias = new Uint8Array(source);
    alias[0] = 29;
    source.resize(65537);
    const moved = structuredClone(source, { transfer: [source] });
    equal([source.byteLength, alias.length], [0, 0]);
    throws(() => source.resize(1), TypeError);
    equal(new Uint8Array(moved)[0], 29);
    moved.resize(8);
    moved.resize(131073);
    equal(new Uint8Array(moved)[65536], 0);
    const direct = moved.transfer(16);
    equal([moved.byteLength, direct.byteLength, direct.maxByteLength, direct.resizable], [0, 16, 131073, true]);
    equal(new Uint8Array(direct)[0], 29);
    throws(() => direct.transfer(2 ** 32 + 16), RangeError);
    equal(direct.byteLength, 16);
    const fixed = direct.transferToFixedLength(32);
    equal([direct.byteLength, fixed.byteLength, fixed.resizable], [0, 32, false]);
    equal(new Uint8Array(fixed)[31], 0);
    Bun.gc(true);
  }
  const ordinary = new ArrayBuffer(4);
  const alias = new Uint8Array(ordinary);
  structuredClone(ordinary, { transfer: [ordinary] });
  equal([ordinary.byteLength, alias.length], [0, 0]);
}

boundsAndZeroing();
callbackGrowth();
maximumMetadata();
transferAndLifetime();
console.log("Resizable backing checks passed");
extendedControls();
