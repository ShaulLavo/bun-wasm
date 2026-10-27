import assert from "node:assert/strict";

export const expectedBytes = [0, 1, 127, 128, 195, 255, 42];
export const expectedText = "Aé😀\0Z";

export function payload(BlobClass: typeof Blob = Blob) {
  const bytes = new Uint8Array(expectedBytes);
  const blob = new BlobClass([bytes], { type: "Application/Octet-Stream" });
  const text = new BlobClass([expectedText], { type: "Text/Plain;Charset=UTF-8" });
  const value = {
    blob, bytes, list: [blob, { text }], empty: new BlobClass(),
    slice: blob.slice(1, -1, "application/x-slice"), text,
    map: new Map([[blob, text]]), set: new Set([blob]),
  };
  bytes.fill(17);
  return Object.assign(value, { self: value });
}

export async function checkPayload(value: ReturnType<typeof payload>, BlobClass: typeof Blob = Blob) {
  assert.ok(value.blob instanceof BlobClass);
  assert.equal(Object.getPrototypeOf(value.blob), BlobClass.prototype);
  assert.equal(value.self, value);
  assert.equal(value.list[0], value.blob);
  const nested = value.list[1];
  assert.ok(nested && "text" in nested);
  assert.equal(nested.text, value.text);
  assert.equal(value.map.get(value.blob), value.text);
  assert.ok(value.set.has(value.blob));
  assert.equal(value.blob.size, expectedBytes.length);
  assert.equal(value.blob.type, "application/octet-stream");
  assert.deepEqual(Array.from(await value.blob.bytes()), expectedBytes);
  assert.deepEqual(Array.from(new Uint8Array(await value.blob.arrayBuffer())), expectedBytes);
  assert.deepEqual(Array.from(await value.slice.bytes()), expectedBytes.slice(1, -1));
  assert.equal(value.slice.type, "application/x-slice");
  assert.equal(value.empty.size, 0);
  assert.equal(value.empty.type, "");
  assert.equal(await value.empty.text(), "");
  assert.equal(await value.text.text(), expectedText);
  assert.equal(value.text.type, "text/plain;charset=utf-8");
  assert.deepEqual(Array.from(value.bytes), expectedBytes.map(() => 17));
  const copy = new Uint8Array(await value.blob.arrayBuffer());
  copy.fill(99);
  assert.deepEqual(Array.from(await value.blob.bytes()), expectedBytes);
  assert.deepEqual(await streamBytes(value.blob), expectedBytes);
}

async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunks: number[] = [];
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return chunks;
    chunks.push(...chunk.value);
  }
}

async function streamBytes(blob: Blob) {
  const reader = blob.stream().getReader();
  try {
    return await readChunks(reader);
  } finally {
    reader.releaseLock();
  }
}
