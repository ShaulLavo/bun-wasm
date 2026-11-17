// Growth, shrink and moved views on resizable ArrayBuffers whose backing grows on demand.
// Allocations between resizes make a growing reallocation move the data, so every kind of
// view, including one that is out of bounds while the backing moves, must follow it.
export {};

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function throws(action: () => void, constructor: typeof Error, label: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`${label}: expected ${constructor.name}`);
}

function zeroFrom(buffer: ArrayBuffer, offset: number): boolean {
  return Buffer.from(buffer, offset).equals(Buffer.alloc(buffer.byteLength - offset));
}

const counting = Array.from({ length: 16 }, (_, index) => index + 1);

function stepwiseGrowth(): void {
  const maximum = 8388608;
  const buffer = new ArrayBuffer(16, { maxByteLength: maximum });
  const tracking = new Uint8Array(buffer);
  const words = new Uint32Array(buffer, 8);
  const fixed = new Uint8Array(buffer, 4, 8);
  const data = new DataView(buffer, 12, 4);
  tracking.set(counting);
  const pressure: Uint8Array[] = [];
  let length = 16;
  let marker = 16;
  while (length < 4194304) {
    const next = Math.min(length * 2 + 5, 4194304);
    pressure.push(new Uint8Array(8192).fill(170));
    buffer.resize(next);
    const at = `growth to ${next}`;
    equal([tracking.length, words.length, fixed.length, data.byteLength], [next, Math.floor((next - 8) / 4), 8, 4], at);
    equal(Array.from(tracking.subarray(0, 16)), counting, at);
    equal([Array.from(fixed), data.getUint8(3), words[0]], [counting.slice(4, 12), 16, 0x0c0b0a09], at);
    equal([tracking[length - 1], tracking[length], tracking[next - 1]], [marker, 0, 0], at);
    marker = (next % 251) + 1;
    tracking[next - 1] = marker;
    length = next;
  }
  equal(pressure.every(block => block.every(value => value === 170)), true, "allocations between resizes");

  buffer.resize(10);
  equal([tracking.length, words.length, fixed.length], [10, 0, 0], "shrink");
  throws(() => data.getUint8(0), TypeError, "out-of-bounds DataView");
  equal(Array.from(tracking), counting.slice(0, 10), "shrink keeps the prefix");
  buffer.resize(maximum);
  equal([tracking.length, fixed.length, data.byteLength], [maximum, 8, 4], "regrowth past the capacity");
  equal([Array.from(fixed), data.getUint8(0), words[0]], [[5, 6, 7, 8, 9, 10, 0, 0], 0, 0x0a09], "shrink cleared bytes");
  equal([tracking[4194303], zeroFrom(buffer, 10)], [0, true], "regrown bytes are zero");
  fixed[7] = 77;
  data.setUint8(3, 78);
  equal([tracking[11], tracking[15]], [77, 78], "views write the moved backing");
}

function outOfBoundsViewMoves(): void {
  const buffer = new ArrayBuffer(1048576, { maxByteLength: 16777216 });
  const far = new Uint8Array(buffer, 1048572, 4);
  const farTracking = new Uint16Array(buffer, 1048572);
  far.set([7, 8, 9, 10]);
  buffer.resize(64);
  equal([far.length, far.byteOffset, farTracking.length], [0, 0, 0], "out of bounds");
  const pressure = new Uint8Array(65536).fill(1);
  buffer.resize(16777216);
  equal([far.length, far.byteOffset, farTracking.length], [4, 1048572, 7864322], "back in bounds after a move");
  equal([Array.from(far), zeroFrom(buffer, 64)], [[0, 0, 0, 0], true], "out-of-bounds bytes were cleared");
  far[0] = 99;
  farTracking[1] = 0x0201;
  equal(Array.from(new Uint8Array(buffer, 1048572, 4)), [99, 0, 1, 2], "moved out-of-bounds views write the new backing");
  equal(pressure[65535], 1, "allocation during the move");
}

function transferGrowth(): void {
  const source = new ArrayBuffer(4, { maxByteLength: 4194304 });
  const view = new Uint8Array(source);
  view.set([1, 2, 3, 4]);
  const grown = source.transfer(2097152);
  equal([source.byteLength, view.length, grown.byteLength, grown.maxByteLength, grown.resizable], [0, 0, 2097152, 4194304, true], "growing transfer");
  const bytes = new Uint8Array(grown);
  equal([Array.from(bytes.subarray(0, 4)), zeroFrom(grown, 4)], [[1, 2, 3, 4], true], "growing transfer contents");
  grown.resize(4194304);
  equal([bytes.length, bytes[0], bytes[4194303]], [4194304, 1, 0], "growth after transfer");
  bytes[4194303] = 5;
  const shrunk = grown.transfer(2);
  equal(Array.from(new Uint8Array(shrunk)), [1, 2], "shrinking transfer");
  shrunk.resize(4194304);
  equal(zeroFrom(shrunk, 2), true, "shrinking transfer cleared bytes");
}

stepwiseGrowth();
outOfBoundsViewMoves();
transferGrowth();
console.log("Resizable growth checks passed");
