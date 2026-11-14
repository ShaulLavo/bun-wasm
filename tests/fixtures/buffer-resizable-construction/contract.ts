interface BufferFactory {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Uint8Array;
  prototype: object;
}

type Check = { name: string; run(): void };

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function invoke(Buffer: BufferFactory, buffer: Uint8Array, method: string, ...args: unknown[]) {
  const fn: unknown = Reflect.get(Buffer.prototype, method);
  if (typeof fn !== "function") throw new Error(`Missing ${method}`);
  return Reflect.apply(fn, buffer, args);
}

function lengths(buffer: Uint8Array) {
  return [buffer.length, buffer.byteLength, buffer.byteOffset];
}

export function constructionChecks(Buffer: BufferFactory): Check[] {
  const checks: Check[] = [];
  const add = (name: string, run: () => void) => checks.push({ name, run });
  add("ordinary ArrayBuffer views share storage with omitted and explicit lengths", () => {
    const ab = new ArrayBuffer(9);
    const omitted = Buffer.from(ab, 2);
    const fixed = Buffer.from(ab, 2, 3);
    equal(lengths(omitted), [7, 7, 2]);
    equal(lengths(fixed), [3, 3, 2]);
    omitted[0] = 0x41;
    equal(fixed[0], 0x41);
    equal(fixed.buffer === ab && omitted.buffer === ab, true);
  });
  if (typeof ArrayBuffer.prototype.resize === "function") addResizableChecks(Buffer, add);
  if (typeof SharedArrayBuffer !== "undefined" && typeof SharedArrayBuffer.prototype.grow === "function") {
    addSharedChecks(Buffer, add);
  }
  return checks;
}

function addResizableChecks(Buffer: BufferFactory, add: (name: string, run: () => void) => void) {
  for (const method of ["hexSlice", "toString"]) add(`${method} observes a shrink during index coercion`, () => {
    checkShrinkingRead(Buffer, method);
  });
  add("hexWrite observes a shrink during length coercion and shares storage", () => {
    const ab = new ArrayBuffer(9, { maxByteLength: 9 });
    const buffer = Buffer.from(ab);
    const shrink = { valueOf() { ab.resize(2); return 1000; } };
    equal(invoke(Buffer, buffer, "hexWrite", "68656c6c6f", 0, shrink), 2);
    equal(buffer.length, 2);
    equal(Array.from(new Uint8Array(ab)), [0x68, 0x65]);
  });
  for (const offset of [undefined, 0, 2]) add(`omitted and undefined lengths track resize at offset ${offset}`, () => {
    checkTrackingResize(Buffer, offset);
  });
  add("explicit lengths stay fixed across shrink and regrow", () => {
    const ab = new ArrayBuffer(9, { maxByteLength: 12 });
    const fixed = Buffer.from(ab, 2, 7);
    const empty = Buffer.from(ab, 2, 0);
    ab.resize(4);
    equal(lengths(fixed), [0, 0, 0]);
    equal(lengths(empty), [0, 0, 2]);
    ab.resize(12);
    equal(lengths(fixed), [7, 7, 2]);
    equal(lengths(empty), [0, 0, 2]);
  });
}

function checkShrinkingRead(Buffer: BufferFactory, method: string) {
  const ab = new ArrayBuffer(9, { maxByteLength: 9 });
  const buffer = Buffer.from(ab);
  buffer.fill(0x41);
  const shrink = { valueOf() { ab.resize(2); return 9; } };
  const args = method === "toString" ? ["hex", 0, shrink] : [0, shrink];
  equal(invoke(Buffer, buffer, method, ...args), "4141");
  equal(buffer.length, 2);
}

function checkTrackingResize(Buffer: BufferFactory, offset: number | undefined) {
  const ab = new ArrayBuffer(9, { maxByteLength: 12 });
  const omitted = Buffer.from(ab, offset);
  const explicitUndefined = Buffer.from(ab, offset, undefined);
  const start = offset ?? 0;
  equal(omitted.buffer === ab && explicitUndefined.buffer === ab, true);
  omitted.fill(0x41);
  for (const size of [4, 1, 9, 12]) {
    ab.resize(size);
    const expected = size < start ? [0, 0, 0] : [size - start, size - start, start];
    equal(lengths(omitted), expected);
    equal(lengths(explicitUndefined), expected);
  }
  omitted[0] = 0x42;
  equal(new Uint8Array(ab)[start], 0x42);
  new Uint8Array(ab)[start + 1] = 0x43;
  equal(explicitUndefined[1], 0x43);
}

function addSharedChecks(Buffer: BufferFactory, add: (name: string, run: () => void) => void) {
  add("omitted shared lengths track growth while explicit lengths stay fixed", () => {
    const ab = new SharedArrayBuffer(4, { maxByteLength: 9 });
    const tracking = Buffer.from(ab, 2);
    const explicitUndefined = Buffer.from(ab, 2, undefined);
    const fixed = Buffer.from(ab, 2, 2);
    const empty = Buffer.from(ab, 2, 0);
    ab.grow(9);
    equal(lengths(tracking), [7, 7, 2]);
    equal(lengths(explicitUndefined), [7, 7, 2]);
    equal(lengths(fixed), [2, 2, 2]);
    equal(lengths(empty), [0, 0, 2]);
    tracking[6] = 0x41;
    equal(new Uint8Array(ab)[8], 0x41);
    equal(tracking.buffer === ab && fixed.buffer === ab, true);
  });
}
