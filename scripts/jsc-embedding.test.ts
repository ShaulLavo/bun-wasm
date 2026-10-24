import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verifyEmbeddingReceipt } from "./jsc-embedding";

const patch = readFileSync(new URL("../jsc/webkit-wasi.patch", import.meta.url), "utf8");

test("WASI resizable allocation returns failure before upstream allocation work", () => {
  expect(patch).toContain("static RefPtr<BufferMemoryHandle> tryAllocateResizableMemory");
  expect(patch).toMatch(/tryAllocateResizableMemory[^\n]*\n \{\n\+#if OS\(WASI\)\n(?:\+[^\n]*\n)*?\+    return nullptr;\n\+#else\n/);
});

const inputs = { sourceHead: "a".repeat(40), sourceTree: "b".repeat(40), jscInputsSha256: "c".repeat(64), archives: [{ path: "libJSC.a", sha256: "d".repeat(64) }] };
const bytes = new Uint8Array([1, 2, 3]);
const receipt = { ...inputs, artifactSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), artifactBytes: bytes.byteLength };

test("JSC receipts bind the committed source, prebuild and guest bytes", () => {
  expect(() => verifyEmbeddingReceipt(receipt, inputs, bytes)).not.toThrow();
  expect(() => verifyEmbeddingReceipt({ ...receipt, sourceHead: "e".repeat(40) }, inputs, bytes)).toThrow("mismatch");
  expect(() => verifyEmbeddingReceipt(receipt, { ...inputs, jscInputsSha256: "f".repeat(64) }, bytes)).toThrow("mismatch");
  expect(() => verifyEmbeddingReceipt(receipt, inputs, new Uint8Array([4, 5, 6]))).toThrow("mismatch");
});
