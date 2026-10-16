import assert from "node:assert/strict";

class AliasedBytes extends Uint8Array {
  slice(start, end) { return this.subarray(start, end); }
}

const inputs = [
  ["Buffer", bytes => Buffer.from(bytes.buffer, 4, 4)],
  ["Uint8Array", bytes => new Uint8Array(bytes.buffer, 4, 4)],
  ["Uint16Array", bytes => new Uint16Array(bytes.buffer, 4, 2)],
  ["DataView", bytes => new DataView(bytes.buffer, 4, 4)],
  ["subclass", bytes => new AliasedBytes(bytes.buffer, 4, 4)],
  ["ArrayBuffer", bytes => bytes.buffer.slice(4, 8)],
];
const bodies = [
  ["Response", input => new Response(input)],
  ["Request", input => new Request("http://localhost/", { method: "POST", body: input })],
];

async function checkBody(name, input, construct, mutateCaller) {
  const buffer = ArrayBuffer.isView(input) ? input.buffer : input;
  const visible = ArrayBuffer.isView(input) ? new Uint8Array(buffer, input.byteOffset, input.byteLength) : new Uint8Array(buffer);
  const byteLength = buffer.byteLength;
  const body = construct(input);
  const copy = body.clone();
  if (mutateCaller) visible[0] = 90;
  const expectedStorage = Array.from(new Uint8Array(buffer));
  void body.body;
  const result = { caller: input.byteLength, storage: buffer.byteLength, body: await body.text(), clone: await copy.text() };
  assert.deepEqual(result, { caller: 4, storage: byteLength, body: "ABCD", clone: "ABCD" }, name);
  assert.deepEqual(Array.from(new Uint8Array(buffer)), expectedStorage, name);
}

let checks = 0;
for (const [kind, factory] of inputs) {
  for (const [bodyKind, construct] of bodies) {
    const bytes = new Uint8Array(16).fill(33);
    bytes.set([65, 66, 67, 68], 4);
    await checkBody(kind + " " + bodyKind, factory(bytes), construct, false);
    await checkBody(kind + " " + bodyKind + " snapshot", factory(bytes), construct, true);
    checks += 2;
  }
}
console.log("body storage", checks);
