import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { artifactIdentity } from "./guest-build-receipt";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verifyEmbeddingReceipt } from "./jsc-embedding";

const patch = readFileSync(new URL("../jsc/webkit-wasi.patch", import.meta.url), "utf8");

test("WASI resizable allocation returns failure before upstream allocation work", () => {
  expect(patch).toContain("static RefPtr<BufferMemoryHandle> tryAllocateResizableMemory");
  expect(patch).toMatch(/tryAllocateResizableMemory[^\n]*\n \{\n\+#if OS\(WASI\)\n(?:\+[^\n]*\n)*?\+    return nullptr;\n\+#else\n/);
});

const inputs = { sourceHead: "a".repeat(40), sourceTree: "b".repeat(40), jscInputsSha256: "c".repeat(64), archives: [{ path: "libJSC.a", sha256: "d".repeat(64) }] };
const bytes = { kind: "jsc", ...quickjsPair("jsc") } as const;
const receipt = { ...inputs, program: { kind: "jsc", core: artifactIdentity(bytes.core), side: artifactIdentity(bytes.side) } };

test("JSC receipts bind the committed source, prebuild and guest bytes", () => {
  expect(() => verifyEmbeddingReceipt(receipt, inputs, bytes)).not.toThrow();
  expect(() => verifyEmbeddingReceipt({ ...receipt, sourceHead: "e".repeat(40) }, inputs, bytes)).toThrow("mismatch");
  expect(() => verifyEmbeddingReceipt(receipt, { ...inputs, jscInputsSha256: "f".repeat(64) }, bytes)).toThrow("mismatch");
  expect(() => verifyEmbeddingReceipt(receipt, inputs, { ...bytes, side: new Uint8Array(Array.from(bytes.side).concat([0, 2, 1, 120])) })).toThrow("mismatch");
  expect(() => verifyEmbeddingReceipt(receipt, inputs, { ...bytes, core: new Uint8Array(Array.from(bytes.core).concat([0, 2, 1, 120])) })).toThrow("mismatch");
});
