import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Writable, Duplex } from "node:stream";
for (const [label, Ctor] of [["writable", Writable], ["duplex", Duplex]]) {
  const input = new ArrayBuffer(4);
  new Uint8Array(input).set([1, 2, 3, 4]);
  let calls = 0;
  const node = new Ctor({
    read() { this.push(null); },
    write(chunk, encoding, callback) {
      calls++;
      assert.equal(Buffer.isBuffer(chunk), true);
      assert.equal(chunk.buffer, input);
      assert.deepEqual(Array.from(chunk), [1, 2, 3, 4]);
      callback();
    },
  });
  const web = Ctor === Duplex ? Ctor.toWeb(node).writable : Ctor.toWeb(node);
  const writer = web.getWriter();
  await writer.write(input);
  await writer.close();
  assert.equal(calls, 1);
  assert.equal(input.byteLength, 4);
  console.log(label + " ArrayBuffer");
}
