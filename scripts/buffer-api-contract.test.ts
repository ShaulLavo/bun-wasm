import { expect, test } from "bun:test";
import { apiChecks } from "../tests/fixtures/buffer-api-contract/checks.ts";
import { loadBufferSource } from "./buffer-source.ts";

const { Buffer: SourceBuffer, transcode } = loadBufferSource();
for (const check of apiChecks(SourceBuffer, transcode)) test(check.name, check.run);

test("concat sizes captured views after all getters shrink their backing", () => {
  const backing = new ArrayBuffer(8, { maxByteLength: 16 });
  const first = SourceBuffer.from(backing).fill(0xaa);
  const list = [first, SourceBuffer.alloc(0)];
  let calls = 0;
  Object.defineProperty(list, 1, { get() { calls++; backing.resize(3); return SourceBuffer.alloc(0); } });
  expect(SourceBuffer.concat(list).toString("hex")).toBe("aaaaaa");
  expect(calls).toBe(1);
  expect(SourceBuffer.concat(list, 5).toString("hex")).toBe("aaaaaa0000");
});
