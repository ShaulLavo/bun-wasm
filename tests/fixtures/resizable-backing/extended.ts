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

function bufferWithValues(): ArrayBuffer {
  const buffer = new ArrayBuffer(4, { maxByteLength: 4194304 });
  new Uint8Array(buffer).set([4, 3, 2, 1]);
  return buffer;
}

function largeZeroing(): void {
  const initial = 1048579;
  const buffer = new ArrayBuffer(initial, { maxByteLength: 6291456 });
  const bytes = new Uint8Array(buffer);
  equal(Buffer.from(buffer).equals(Buffer.alloc(initial)), true);
  bytes.fill(61);
  bytes[initial - 1] = 94;
  const sentinel = new Uint8Array(4096).fill(90);
  buffer.resize(4194311);
  equal([bytes[initial - 2], bytes[initial - 1]], [61, 94]);
  equal(Buffer.from(buffer, initial).equals(Buffer.alloc(buffer.byteLength - initial)), true);
  bytes.fill(73, initial);
  buffer.resize(13);
  buffer.resize(5242885);
  equal(Array.from(bytes.subarray(0, 13)), new Array(13).fill(61));
  equal(Buffer.from(buffer, 13).equals(Buffer.alloc(buffer.byteLength - 13)), true);
  equal(Array.from(sentinel), new Array(4096).fill(90));
}

function bulkCoercion(): void {
  const buffer = bufferWithValues();
  const fixed = new Uint8Array(buffer, 0, 4);
  Reflect.apply(Uint8Array.prototype.copyWithin, fixed, [{ valueOf() { buffer.resize(65537); return 1; } }, 0, 3]);
  equal(Array.from(fixed), [4, 4, 3, 2]);
  Reflect.apply(Uint8Array.prototype.fill, fixed, [{ valueOf() { buffer.resize(131073); return 9; } }, 1, 3]);
  equal(Array.from(fixed), [4, 9, 9, 2]);
  const mapped = Reflect.apply(Uint8Array.prototype.map, fixed, [(value: number) => ({ valueOf() { buffer.resize(196609); return value * 2; } })]);
  equal(Array.from(mapped), [8, 18, 18, 4]);
  Reflect.apply(Uint8Array.prototype.sort, fixed, [(left: number, right: number) => ({ valueOf() { buffer.resize(262145); return left - right; } })]);
  equal(Array.from(fixed), [2, 4, 9, 9]);
  const data = new DataView(buffer, 2);
  Reflect.apply(DataView.prototype.setUint16, data, [0, { valueOf() { buffer.resize(327681); return 0x1234; } }, false]);
  equal([fixed[2], fixed[3]], [0x12, 0x34]);
  equal(Reflect.apply(DataView.prototype.getUint16, data, [{ valueOf() { buffer.resize(393217); return 0; } }, false]), 0x1234);
}

function speciesGrowth(): void {
  const buffer = bufferWithValues();
  const view = new Uint8Array(buffer, 0, 4);
  Object.defineProperty(view, "constructor", { value: { [Symbol.species]: class extends Uint8Array {
    constructor(length: number) { buffer.resize(65537); super(length); }
  } } });
  equal(Array.from(view.slice()), [4, 3, 2, 1]);
  Object.defineProperty(buffer, "constructor", { value: { [Symbol.species]: class extends ArrayBuffer {
    constructor(length: number) { buffer.resize(131073); super(length); }
  } } });
  equal(Array.from(new Uint8Array(buffer.slice(0, 4))), [4, 3, 2, 1]);
}

function changingIteration(mode: "shrink" | "detach" | "transfer"): void {
  const buffer = bufferWithValues();
  const view = new Uint8Array(buffer, 0, 4);
  const seen: (number | string)[] = [];
  let destination: ArrayBuffer | undefined;
  view.forEach((value, index) => {
    seen.push(value === undefined ? "missing" : value);
    if (index === 0) destination = changeBuffer(buffer, mode);
    if (index === 1 && mode === "shrink") buffer.resize(65537);
  });
  equal(seen, mode === "shrink" ? [4, "missing", 0, 0] : [4, "missing", "missing", "missing"]);
  if (destination) equal(Array.from(new Uint8Array(destination)), [4, 3, 2, 1]);
}

function changeBuffer(buffer: ArrayBuffer, mode: "shrink" | "detach" | "transfer"): ArrayBuffer | undefined {
  if (mode === "shrink") { buffer.resize(0); return; }
  if (mode === "transfer") return buffer.transfer();
  structuredClone(buffer, { transfer: [buffer] });
}

function publicWidthAndOrder(): void {
  const buffer = bufferWithValues();
  for (const wide of [2 ** 32, 2 ** 32 + 1, 2 ** 32 + 4, 2 ** 40]) {
    throws(() => buffer.resize(wide), RangeError);
    throws(() => buffer.transfer(wide), RangeError);
    equal(Array.from(new Uint8Array(buffer)), [4, 3, 2, 1]);
  }
  Reflect.apply(ArrayBuffer.prototype.resize, buffer, [{ valueOf() { buffer.resize(65537); return 16; } }]);
  equal(buffer.byteLength, 16);
  throws(() => Reflect.apply(ArrayBuffer.prototype.resize, buffer, [{ valueOf() { buffer.resize(2); return 2 ** 32 + 2; } }]), RangeError);
  equal([buffer.byteLength].concat(Array.from(new Uint8Array(buffer))), [2, 4, 3]);
  throws(() => Reflect.apply(ArrayBuffer.prototype.resize, buffer, [{ valueOf() { structuredClone(buffer, { transfer: [buffer] }); return 2 ** 32; } }]), TypeError);
  equal(buffer.byteLength, 0);
  const source = bufferWithValues();
  throws(() => Reflect.apply(ArrayBuffer.prototype.transfer, source, [{ valueOf() { source.transfer(); return 2 ** 32; } }]), TypeError);
  const sourceFixed = bufferWithValues();
  throws(() => Reflect.apply(ArrayBuffer.prototype.transferToFixedLength, sourceFixed, [{ valueOf() { sourceFixed.transfer(); return 2 ** 32; } }]), TypeError);
  const smallMaximum = new ArrayBuffer(4, { maxByteLength: 4 });
  const fixed = smallMaximum.transferToFixedLength(16);
  equal([fixed.byteLength, fixed.resizable, smallMaximum.byteLength], [16, false, 0]);
}

export function extendedControls(): void {
  largeZeroing();
  bulkCoercion();
  speciesGrowth();
  changingIteration("shrink");
  changingIteration("detach");
  changingIteration("transfer");
  publicWidthAndOrder();
  console.log("Extended resizable backing checks passed");
}
