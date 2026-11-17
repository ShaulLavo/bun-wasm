// A resize or transfer that the 1 GiB wasm32 guest cannot back throws the spec's RangeError
// and leaves the buffer, its views and later growth intact. JSC and SpiderMonkey grow their
// backing on demand. QuickJS throws InternalError here and Browser runs on the host's memory.
export {};

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function rangeError(action: () => void, label: string): void {
  try {
    action();
  } catch (error) {
    if (error instanceof RangeError) return;
    throw new Error(`${label}: expected RangeError, received ${String(error)}`);
  }
  throw new Error(`${label}: expected RangeError`);
}

const counting = Array.from({ length: 16 }, (_, index) => index + 1);
const maximum = 1610612736;
const buffer = new ArrayBuffer(16, { maxByteLength: maximum });
const tracking = new Uint8Array(buffer);
const fixed = new Uint8Array(buffer, 4, 4);
tracking.set(counting);

for (const request of [maximum, 1073741824]) {
  rangeError(() => buffer.resize(request), `resize to ${request}`);
  equal([buffer.byteLength, tracking.length, Array.from(tracking)], [16, 16, counting], `failed resize to ${request}`);
  rangeError(() => buffer.transfer(request), `transfer to ${request}`);
  equal([buffer.byteLength, buffer.maxByteLength, Array.from(tracking)], [16, maximum, counting], `failed transfer to ${request}`);
}

buffer.resize(65537);
equal([tracking.length, tracking[65536], Array.from(fixed)], [65537, 0, [5, 6, 7, 8]], "growth after failures");

// The failed requests left no backing behind: four 64 MiB buffers still fit.
const blocks = Array.from({ length: 4 }, () => new ArrayBuffer(0, { maxByteLength: 268435456 }));
for (const block of blocks) {
  block.resize(67108864);
  const bytes = new Uint8Array(block);
  bytes[67108863] = 1;
  equal([bytes[0], bytes[67108863]], [0, 1], "growth of other buffers");
}

console.log("Resizable allocation failures throw RangeError and keep the buffer");
