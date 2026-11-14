const before = process.memoryUsage();
if (typeof before.wasmCapacity !== "number") {
  throw new Error(`Expected numeric Wasm capacity, got ${before.wasmCapacity}`);
}
console.log("capacity is positive bytes", before.wasmCapacity > 0 && Number.isSafeInteger(before.wasmCapacity));
console.log("capacity is page aligned", before.wasmCapacity % 65536 === 0);
console.log("rss stays unknown", before.rss === null && process.memoryUsage.rss() === null);

const buffer = new Uint8Array(1024 * 1024);
buffer[buffer.length - 1] = 42;
const after = process.memoryUsage();
console.log("capacity does not shrink", typeof after.wasmCapacity === "number" && after.wasmCapacity >= before.wasmCapacity);
console.log("buffer remains usable", buffer[buffer.length - 1] === 42);
