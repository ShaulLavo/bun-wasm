import assert from "node:assert/strict";

type Transcode = typeof import("node:buffer").transcode;

export function apiChecks(factory: typeof Buffer, transcode: Transcode) {
  return [
    { name: "numeric accessors validate receivers after offset arguments", run() {
      for (const method of ["readInt32LE", "readFloatLE", "readBigInt64LE"]) {
        const read = Reflect.get(factory.prototype, method);
        assert.throws(() => Reflect.apply(read, {}, [0]), { code: "ERR_INVALID_ARG_TYPE" });
        assert.throws(() => Reflect.apply(read, {}, [1.5]), { code: "ERR_INVALID_ARG_TYPE" });
        assert.throws(() => Reflect.apply(read, {}, ["bad"]), /"offset" argument/);
        assert.throws(() => Reflect.apply(read, new DataView(new ArrayBuffer(16)), [0]), /<= NaN/);
      }
      assert.throws(() => Reflect.apply(factory.prototype.writeBigInt64LE, {}, [2n ** 64n, 0]), /"value"/);
      assert.throws(() => Reflect.apply(factory.prototype.writeBigInt64LE, {}, [5n, 0]), { code: "ERR_INVALID_ARG_TYPE" });
    } },
    { name: "numeric accessors address bytes within the receiver element bound", run() {
      const words = new Uint16Array([0x1234, 0x5678, 0x9abc, 0xdef0]);
      const bytes = new DataView(words.buffer);
      assert.equal(Reflect.apply(factory.prototype.readInt32LE, words, [0]), bytes.getInt32(0, true));
      assert.equal(Reflect.apply(factory.prototype.writeUInt16BE, words, [0x2345, 1]), 3);
      assert.equal(bytes.getUint16(1, false), 0x2345);
      assert.equal(Reflect.apply(factory.prototype.readFloatLE, words, [0]), bytes.getFloat32(0, true));
      assert.throws(() => Reflect.apply(factory.prototype.readInt32LE, words, [1]), { code: "ERR_OUT_OF_RANGE" });
      assert.throws(() => Reflect.apply(factory.prototype.readBigInt64LE, words, [0]), { code: "ERR_BUFFER_OUT_OF_BOUNDS" });
    } },
    { name: "one-byte writes validate offset types before value ranges", run() {
      const buffer = factory.alloc(8);
      for (const method of ["writeUInt8", "writeInt8", "writeUIntLE", "writeIntBE"]) {
        assert.throws(() => Reflect.apply(Reflect.get(buffer, method), buffer, [300, "bad", 1]), /"offset" argument/);
      }
      assert.throws(() => Reflect.apply(buffer.writeUIntLE, buffer, [2 ** 24, "bad", 2]), /"value"/);
      assert.throws(() => Reflect.apply(buffer.writeUIntLE, buffer, [1, undefined, 2]), /"offset" argument/);
    } },
    { name: "concat captures each input getter once before copying", run() {
      let calls = 0;
      const input = [factory.from([1, 2]), factory.from([3])];
      Object.defineProperty(input, 1, { get() { calls++; return factory.from([3]); } });
      assert.equal(factory.concat(input).toString("hex"), "010203");
      assert.equal(calls, 1);
      assert.equal(factory.concat([factory.from([1])], 3).toString("hex"), "010000");
    } },
    { name: "transcode substitutes once per code point and preserves BOMs", run() {
      assert.equal(typeof transcode, "function");
      for (const encoding of ["utf8", "ucs2"] satisfies BufferEncoding[]) {
        assert.equal(transcode(factory.from("Aé🦊\ud800Z", encoding), encoding, "ascii").toString("hex"), "413f3f3f5a");
      }
      assert.equal(transcode(factory.from([0xef, 0xbb, 0xbf, 65]), "utf8", "utf8").toString("hex"), "efbbbf41");
      assert.equal(transcode(factory.from([0xe4]), "ascii", "ucs2").toString("hex"), "e400");
      assert.equal(transcode(factory.from([65]), "ucs2", "ucs2").toString("hex"), "fdff");
      assert.equal(transcode(factory.from([65, 0, 66]), "ucs2", "latin1").toString("hex"), "41");
    } },
    { name: "transcode reports encoding and malformed conversion errors", run() {
      assert.throws(() => Reflect.apply(transcode, undefined, []), { code: "ERR_INVALID_ARG_TYPE" });
      assert.throws(() => transcode(factory.from([65]), "base64", "utf8"), { code: "U_ILLEGAL_ARGUMENT_ERROR", errno: 1 });
      assert.throws(() => transcode(factory.from([0xc0, 65]), "utf8", "ucs2"), { code: "U_INVALID_CHAR_FOUND", errno: 10 });
      assert.throws(() => transcode(factory.from([0, 0xd8]), "ucs2", "utf8"), { code: "U_INVALID_CHAR_FOUND", errno: 10 });
      assert.equal(Reflect.apply(transcode, undefined, [factory.alloc(0), "bad", "bad"]).length, 0);
    } },
  ];
}
