import assert from "node:assert/strict";

export function residualChecks(factory: typeof Buffer) {
  return [
    { name: "fill selects overloads by value and ignores end without a start", run() {
      for (const value of [0, true, new Uint8Array([1])]) {
        const buffer = factory.alloc(5);
        assert.throws(() => Reflect.apply(buffer.fill, buffer, [value, "hex", 3]), { code: "ERR_INVALID_ARG_TYPE" });
      }
      for (const end of [3, "3", -1, null, { valueOf() { throw new Error("end coerced"); } }]) {
        const buffer = factory.alloc(5, 0xaa);
        Reflect.apply(buffer.fill, buffer, [0, undefined, end]);
        assert.equal(buffer.toString("hex"), "0000000000");
      }
    } },
    { name: "fill validates encoding before an empty range without encoding the value", run() {
      for (const encoding of [NaN, false, "bogus"]) {
        const buffer = factory.alloc(4, 0xaa);
        assert.throws(() => Reflect.apply(buffer.fill, buffer, ["a", 0, 0, encoding]), TypeError);
        assert.equal(buffer.toString("hex"), "aaaaaaaa");
      }
      assert.equal(factory.alloc(4).fill("not hex", 0, 0, "hex").length, 4);
      const buffer = factory.alloc(4);
      Reflect.apply(buffer.fill, buffer, ["é", undefined, undefined, "bogus"]);
      assert.equal(buffer.toString("hex"), "c3a9c3a9");
      assert.equal(factory.alloc(4).fill("a", 0, 0, "utf8").length, 4);
    } },
    { name: "fill defaults null and empty encoding while toString rejects them", run() {
      for (const encoding of [null, ""]) {
        const buffer = factory.alloc(5, 0xaa);
        Reflect.apply(buffer.fill, buffer, ["a", 1, 3, encoding]);
        assert.equal(buffer.toString("hex"), "aa6161aaaa");
        assert.throws(() => Reflect.apply(buffer.toString, buffer, [encoding]), { code: "ERR_UNKNOWN_ENCODING" });
      }
      assert.throws(() => Reflect.apply(factory.alloc, factory, [3, "a", new String("")]), TypeError);
    } },
    { name: "numeric offsets distinguish infinity from fractional and NaN offsets", run() {
      const buffer = factory.alloc(16);
      for (const method of [buffer.readBigInt64LE, buffer.readBigInt64BE, buffer.readBigUInt64LE, buffer.readBigUInt64BE]) {
        checkOffsets(buffer, method, [], 8);
      }
      for (const method of [buffer.writeBigInt64LE, buffer.writeBigInt64BE, buffer.writeBigUInt64LE, buffer.writeBigUInt64BE]) {
        checkOffsets(buffer, method, [1n], 8);
      }
      checkOffsets(buffer, buffer.readUInt32LE, [], 12);
      assert.equal(buffer.writeBigUInt64LE(0xffffffffffffffffn, 8), 16);
      assert.equal(buffer.readBigUInt64LE(8), 0xffffffffffffffffn);
      assert.throws(() => factory.alloc(7).readBigUInt64LE(), { code: "ERR_BUFFER_OUT_OF_BOUNDS" });
    } },
    { name: "UTF-16 searches reject odd-byte matches and floor reverse offsets", run() {
      const buffer = factory.from([0, 0x61, 0, 0]);
      const needle = factory.from("a", "utf16le");
      assert.equal(buffer.lastIndexOf(needle, undefined, "utf16le"), -1);
      assert.equal(buffer.lastIndexOf("a", undefined, "utf16le"), -1);
      assert.equal(buffer.indexOf("a", 0, "utf16le"), -1);
      assert.equal(factory.from("aaaa", "utf16le").lastIndexOf("a", 5, "ucs2"), 4);
      assert.equal(factory.from("aaaa", "utf16le").lastIndexOf("a", 3, "ucs2"), 2);
      assert.equal(buffer.indexOf(0x61, 0, "ucs2"), 1);
    } },
    { name: "UTF-16 buffer and string needles wrap odd-length haystacks differently", run() {
      const buffer = factory.from([0x62, 0x62, 0x62]);
      const needle = factory.from([0x62, 0x62]);
      for (const encoding of ["ucs2", "ucs-2", "utf16le", "utf-16le"] satisfies BufferEncoding[]) {
        assert.equal(buffer.lastIndexOf(needle, -3, encoding), 0);
        assert.equal(buffer.lastIndexOf(needle, -2, encoding), 0);
        assert.equal(buffer.indexOf(needle, -2, encoding), -1);
        assert.equal(buffer.lastIndexOf("\u6262", -3, encoding), -1);
        assert.equal(buffer.lastIndexOf(factory.alloc(0), 3, encoding), 2);
      }
      const five = factory.from([0x62, 0x62, 0x62, 0x62, 0x63]);
      assert.equal(five.lastIndexOf(needle, -3, "ucs2"), 2);
      assert.equal(five.lastIndexOf(factory.from([0x62, 0x62, 0x62]), 0, "ucs2"), 0);
      assert.equal(five.indexOf(factory.from([0x62, 0x62, 0x62]), 2, "ucs2"), -1);
      assert.equal(factory.from([0x62]).lastIndexOf(needle, 0, "ucs2"), -1);
    } },
    { name: "toLocaleString shares the toString function", run() {
      assert.equal(factory.prototype.toLocaleString, factory.prototype.toString);
      const buffer = factory.from([0xff]);
      assert.equal(Reflect.apply(buffer.toLocaleString, buffer, ["hex"]), "ff");
    } },
  ];
}

function checkOffsets(receiver: Buffer, method: (...args: never[]) => unknown, prefix: unknown[], max: number) {
  for (const offset of [Infinity, -Infinity, -1, max + 1, NaN, 0.5, -1.5]) {
    const range = Number.isNaN(offset) || offset % 1 !== 0 && Number.isFinite(offset) ? "an integer" : `>= 0 and <= ${max}`;
    assert.throws(() => Reflect.apply(method, receiver, prefix.concat([offset])), {
      code: "ERR_OUT_OF_RANGE",
      message: `The value of "offset" is out of range. It must be ${range}. Received ${offset}`,
    });
  }
}
