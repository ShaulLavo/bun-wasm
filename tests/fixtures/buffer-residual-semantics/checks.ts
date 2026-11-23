import assert from "node:assert/strict";

const noop = () => {};

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
      assert.throws(() => Reflect.apply(factory.alloc, factory, [3, "a", new String("")]), { code: "ERR_INVALID_ARG_TYPE" });
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
      assert.equal(Reflect.apply(buffer.lastIndexOf, buffer, [needle, undefined, "utf16le"]), -1);
      assert.equal(Reflect.apply(buffer.lastIndexOf, buffer, ["a", undefined, "utf16le"]), -1);
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
    { name: "public Buffer methods remain enumerable for instance mocks", run() {
      const buffer = factory.alloc(0);
      for (const name of ["write", "writeUInt8", "writeBigInt64LE", "toString", "toLocaleString", "slice"]) {
        assert.equal(Object.getOwnPropertyDescriptor(factory.prototype, name)?.enumerable, true);
      }
      for (const name in factory.prototype) {
        if (typeof Reflect.get(buffer, name) === "function") Reflect.set(buffer, name, noop);
      }
      assert.doesNotThrow(() => buffer.write("hello"));
      assert.doesNotThrow(() => buffer.writeUInt8(0));
      assert.doesNotThrow(() => buffer.writeBigInt64LE(0n));
    } },
    { name: "fill clamps and survives detach or resize during value and encoding coercion", run() {
      const detachedByValueOf = factory.alloc(16, 0xcc);
      assert.equal(detachedByValueOf.fill({ valueOf() { detachedByValueOf.buffer.transfer(0); return 0x42; } } as unknown as number), detachedByValueOf);
      assert.equal(detachedByValueOf.byteLength, 0);

      const detachedByToString = factory.alloc(16, 0xcc);
      assert.equal(detachedByToString.fill({ toString() { detachedByToString.buffer.transfer(0); return "42"; } } as unknown as number), detachedByToString);
      assert.equal(detachedByToString.byteLength, 0);

      const detachedByEnc = factory.alloc(16, 0xcc);
      assert.equal(detachedByEnc.fill("A", 0, 16, { toString() { detachedByEnc.buffer.transfer(0); return "utf8"; } } as unknown as BufferEncoding), detachedByEnc);
      assert.equal(detachedByEnc.byteLength, 0);

      const rab = new ArrayBuffer(64, { maxByteLength: 64 });
      const resized = factory.from(rab);
      resized.fill(0x00);
      resized.fill("A", 0, 64, { toString() { rab.resize(8); return "utf8"; } } as unknown as BufferEncoding);
      assert.equal(resized.length, 8);
      assert.equal(resized.toString("ascii"), "AAAAAAAA");

      // Pattern validation must happen after clamping against the live destination length.
      const detachedHex = factory.alloc(4, 1);
      assert.equal(
        detachedHex.fill("g", 0, 4, { toString() { detachedHex.buffer.transfer(); return "hex"; } } as unknown as BufferEncoding),
        detachedHex,
      );

      // Detached and empty views report Bun's ERR_INVALID_ARG_VALUE ("Buffer cannot be empty"),
      // and shadowed byteLength properties on views are ignored.
      const dvAb = new ArrayBuffer(4);
      const detachedDv = new DataView(dvAb);
      dvAb.transfer();
      assert.throws(() => factory.alloc(4).fill(detachedDv as unknown as Uint8Array), { code: "ERR_INVALID_ARG_VALUE", message: "Buffer cannot be empty" });
      assert.throws(() => factory.alloc(4).fill(new Uint8Array(0)), { code: "ERR_INVALID_ARG_VALUE", message: "Buffer cannot be empty" });
      const shadowed = new Uint8Array([0x41, 0x42]);
      Object.defineProperty(shadowed, "byteLength", { value: 0 });
      assert.equal(factory.alloc(4).fill(shadowed).toString("utf8"), "ABAB");
    } },
    { name: "indexOf coerces encoding on Buffer needles and handles detached haystack or needle", run() {
      const ab = new ArrayBuffer(16);
      const haystack = factory.from(ab);
      haystack.fill(0x42);
      const needle = factory.from([0x42]);
      assert.equal(haystack.indexOf(needle, 0, { toString() { ab.transfer(32); return "utf8"; } } as unknown as BufferEncoding), -1);

      const buf = factory.from("abcdef");
      const needleAb = new ArrayBuffer(3);
      const detachedNeedle = factory.from(needleAb);
      detachedNeedle.set([0x62, 0x63, 0x64]);
      assert.equal(buf.indexOf(detachedNeedle, 0, { toString() { needleAb.transfer(32); return "utf8"; } } as unknown as BufferEncoding), 0);
      assert.equal(factory.from("ello hello hello").lastIndexOf("hello", "utf8"), 11);

      // lastIndexOf uses initial pre-coercion length when offset coerces to NaN.
      const growAb = new ArrayBuffer(2, { maxByteLength: 8 });
      const growBuf = factory.from(growAb);
      assert.equal(growBuf.lastIndexOf("", { valueOf() { growAb.resize(4); return NaN; } } as unknown as number), 2);

      // Ordinary string coercion rejects Symbol encodings for Buffer needles too.
      assert.throws(() => factory.from("abc").indexOf(factory.from("a"), 0, Symbol("encoding") as unknown as BufferEncoding), { name: "TypeError" });

      // Live empty vs detached empty haystack with empty needle.
      const liveEmpty = factory.alloc(0);
      assert.equal(liveEmpty.indexOf(""), 0);
      assert.equal(liveEmpty.lastIndexOf(""), 0);
      const detachedEmpty = factory.alloc(4);
      detachedEmpty.buffer.transfer();
      assert.equal(detachedEmpty.indexOf(""), -1);
      assert.equal(detachedEmpty.lastIndexOf(""), -1);
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
