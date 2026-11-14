import { expect, test } from "bun:test";
import { constructionChecks } from "../tests/fixtures/buffer-resizable-construction/contract.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: SourceBuffer } = loadBufferSource();
for (const check of constructionChecks(SourceBuffer)) test(check.name, check.run);

function constructionResult(factory: typeof Buffer, offset: unknown, length: unknown) {
  const ab = new ArrayBuffer(9, { maxByteLength: 12 });
  const calls: string[] = [];
  const coerce = (name: string, value: unknown) => ({ valueOf() { calls.push(name); return value; } });
  try {
    const buffer = Reflect.apply(factory.from, factory, [ab, coerce("offset", offset), coerce("length", length)]);
    return { calls, length: buffer.length, offset: buffer.byteOffset, shares: buffer.buffer === ab };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("name" in error)) throw error;
    return { calls, name: error.name, code: "code" in error ? error.code : undefined };
  }
}

test("construction retains native offset and length coercion and error ordering", () => {
  for (const offset of [0, 1.5, NaN, Infinity, 10]) {
    for (const length of [-1, 0, 2.5, NaN, Infinity, 10, null]) {
      expect(constructionResult(SourceBuffer, offset, length)).toEqual(constructionResult(Buffer, offset, length));
    }
  }
});
