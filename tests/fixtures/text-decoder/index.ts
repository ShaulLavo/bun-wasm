import { strict as assert } from "node:assert";
import { singleByteCases } from "./cases";

for (const [encoding, input, output] of singleByteCases) {
  const decoder = new TextDecoder(encoding);
  assert.equal(decoder.encoding, encoding);
  assert.equal(decoder.decode(Uint8Array.from(input)), output);
}

function chunks(encoding: string, input: readonly number[], output: string) {
  for (let width = 1; width <= 5; width++) {
    const decoder = new TextDecoder(encoding);
    let text = "";
    for (let offset = 0; offset < input.length; offset += width) {
      const bytes = Uint8Array.from(input.slice(offset, offset + width));
      text += decoder.decode(bytes, { stream: true });
    }
    assert.equal(text + decoder.decode(), output);
    assert.equal(decoder.decode(), "");
  }
}

chunks("utf-8", [0xef, 0xbb, 0xbf, 65, 0xf4, 0x8f, 0xbf, 0xbf], "A􏿿");
chunks("utf-16le", [255, 254, 65, 0, 0xff, 0xdb, 0xff, 0xdf], "A􏿿");
chunks("utf-16be", [254, 255, 0, 65, 0xdb, 0xff, 0xdf, 0xff], "A􏿿");

const malformed = new TextDecoder();
assert.equal(malformed.decode(Uint8Array.of(0xf0), { stream: true }), "");
assert.equal(malformed.decode(Uint8Array.of(0x8f), { stream: true }), "��");
assert.equal(malformed.decode(Uint8Array.of(0xc1), { stream: true }), "�");
assert.equal(malformed.decode(), "");

for (const [encoding, invalid, bom] of [
  ["utf-8", [255], [0xef, 0xbb, 0xbf, 65]],
  ["utf-16le", [0, 0xdc], [255, 254, 65, 0]],
  ["utf-16be", [0xdc, 0], [254, 255, 0, 65]],
] satisfies [string, number[], number[]][]) {
  const decoder = new TextDecoder(encoding, { fatal: true });
  assert.throws(() => decoder.decode(Uint8Array.from(invalid), { stream: true }), { name: "TypeError", code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  assert.equal(decoder.decode(Uint8Array.from(bom)), "A");
  assert.throws(() => decoder.decode(Uint8Array.of(0xc0)), TypeError);
  assert.equal(decoder.decode(), "");
}

const pending = new TextDecoder();
pending.decode(Uint8Array.of(0xf0, 0x9f), { stream: true });
for (const value of [5, "x", true, 0n, Symbol()]) {
  assert.throws(() => Reflect.construct(TextDecoder, ["utf-8", value]), { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
  assert.throws(() => Reflect.apply(pending.decode, pending, [new Uint8Array(), value]), { name: "TypeError", code: "ERR_INVALID_ARG_TYPE" });
}
assert.equal(pending.decode(Uint8Array.of(0x92, 0xa9)), "💩");
assert.equal(Reflect.apply(pending.decode, pending, [Uint8Array.of(65), null]), "A");
assert.throws(() => new TextDecoder("replacement"), RangeError);
assert.equal(new TextDecoder("ascii").decode(Uint8Array.of(0x80)), "€");
console.log("TextDecoder native codec, streaming, fatal and dictionary controls passed");
