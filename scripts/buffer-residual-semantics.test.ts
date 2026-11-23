import { expect, test } from "bun:test";
import { residualChecks } from "../tests/fixtures/buffer-residual-semantics/checks.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: GuestBuffer } = loadBufferSource();
for (const check of residualChecks(GuestBuffer)) test(check.name, check.run);

function searchMatrix(factory: typeof Buffer) {
  const offsets = [-8, -5, -3, -2, -1, 0, 1, 2, 3, 4, 5, 8, undefined, NaN, Infinity];
  const needles = ["", "a", "\u6262", factory.alloc(0), factory.from([0x62]), factory.from([0x62, 0x62]), factory.from([0x62, 0x62, 0x62])];
  const result: number[][] = [];
  for (const bytes of [[0, 0x61, 0, 0], [0x62, 0x62, 0x63], [0x62, 0x62, 0x62, 0x62, 0x63]]) {
    const buffer = factory.from(bytes);
    for (const needle of needles) {
      result.push(offsets.flatMap(offset => [buffer.indexOf(needle, offset ?? 0, "utf16le"), buffer.lastIndexOf(needle, offset ?? buffer.length, "utf16le")]));
    }
  }
  return result;
}

test("UTF-16 search offsets match native Bun for small string and Buffer needles", () => {
  expect(searchMatrix(GuestBuffer)).toEqual(searchMatrix(Buffer));
});

test("unknown encoding object is coerced once during indexOf", () => {
  let calls = 0;
  expect(() => GuestBuffer.from("abc").indexOf("a", 0, {
    toString() {
      calls++;
      return "bogus";
    },
  } as unknown as BufferEncoding)).toThrow(expect.objectContaining({ code: "ERR_UNKNOWN_ENCODING", message: "Unknown encoding: bogus" }));
  expect(calls).toBe(1);
});
