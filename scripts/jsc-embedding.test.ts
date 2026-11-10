import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { artifactIdentity } from "./guest-build-receipt";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { handshakeCommands, parserChainFixture, stackFixture, verifyEmbeddingReceipt } from "./jsc-embedding";

const patch = readFileSync(new URL("../jsc/webkit-wasi.patch", import.meta.url), "utf8");

test("WASI resizable allocation returns failure before upstream allocation work", () => {
  expect(patch).toContain("static RefPtr<BufferMemoryHandle> tryAllocateResizableMemory");
  expect(patch).toMatch(/tryAllocateResizableMemory[^\n]*\n \{\n\+#if OS\(WASI\)\n(?:\+[^\n]*\n)*?\+    return nullptr;\n\+#else\n/);
});

test("WASI regexp matching preserves recursion errors instead of returning no match", () => {
  expect(patch.includes("return static_cast<unsigned>(JSRegExpResult::ErrorNoMemory);")).toBe(true);
  const callers = patch.split("diff --git a/Source/JavaScriptCore/runtime/RegExpInlines.h")[1]?.split("diff --git")[0];
  expect(callers).toBeDefined();
  expect(callers?.match(/result == static_cast<int>\(Yarr::JSRegExpResult::ErrorNoMemory\)/g)).toHaveLength(2);
  expect(callers?.match(/throwScope\.throwException\(nullOrGlobalObject, Yarr::errorToThrow/g)).toHaveLength(2);
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

test("the JSC artifact check runs the busy-loop stdout handshake on the same guest", () => {
  const [command] = handshakeCommands("/dist/bun-jsc.wasm");
  expect(command!.slice(2)).toEqual([new URL("../tests/test-stdout-busy-loop.ts", import.meta.url).pathname, "--engine", "jsc", "--wasm", "/dist/bun-jsc.wasm"]);
});

test("only the two parser sites read the parser reserve; every other reservation stays constant", () => {
  const sites = patch.match(/^\+ *WASM_RESERVE_STACK\(.*\);$/gm) ?? [];
  expect(sites).toHaveLength(22);
  expect(sites.filter(site => site.includes("2048 - wasmParserReserveDiscount"))).toHaveLength(2);
  expect(sites.filter(site => /WASM_RESERVE_STACK\((?:512|1024|2048)\);$/.test(site))).toHaveLength(20);
  const parser = patch.split("diff --git a/Source/JavaScriptCore/parser/Parser.cpp")[1]?.split("diff --git")[0] ?? "";
  // The discount is zero-initialized data: no initializer, so zero-filled memory means 2048.
  expect(parser).toContain("+static uint32_t wasmParserReserveDiscount;\n");
  expect(parser).toContain("+    RELEASE_ASSERT(bytes >= 512 && bytes <= 2048 && !(bytes % 16));\n+    wasmParserReserveDiscount = 2048 - bytes;\n");
  expect(parser.match(/wasmParserReserveDiscount/g)).toHaveLength(4);
  expect(parser).toMatch(/\+    WASM_RESERVE_STACK\(2048\);\n\+    failIfStackOverflow\(\);\n     ASSERT\(match\(AWAIT\)\);/);
  // One definition and one declaration: nothing in WebKit calls the setter.
  expect(patch.match(/setWasmParserReserve/g)).toHaveLength(2);
});

test("the adapter sets the parser reserve once, inside the existing JSC initialize callback", () => {
  const helpers = readFileSync(new URL("../crates/bunwasm-jsc/cpp/helpers.cpp", import.meta.url), "utf8");
  expect(helpers.match(/setWasmParserReserve/g)).toHaveLength(1);
  expect(helpers.match(/BUN_WASM_JSC_PARSER_RESERVE"/g)).toHaveLength(1);
  const callback = helpers.split("JSC::initialize([] {")[1]?.split("});")[0] ?? "";
  expect(callback).toContain('if (unsigned reserve = parserReserveSetting(getenv("BUN_WASM_JSC_PARSER_RESERVE")))\n            JSC::setWasmParserReserve(reserve);');
  expect(helpers.indexOf("JSC::setWasmParserReserve")).toBeLessThan(helpers.indexOf("VM::createContextGroup()"));
});

test("the JSC gate requires the parser chain fixture's deeper chain to be refused", () => {
  expect(parserChainFixture()).toEqual({ path: "tests/fixtures/parser-chain-stack", hostOptions: ["--env", "BUNWASM_STACK_EXPECT_CAUGHT=1"] });
});

test("JSC stack controls use their discovered fixture with a small real host stack", () => {
  expect(stackFixture()).toEqual({
    path: "tests/fixtures/stack-getter-headroom",
    hostOptions: ["--stack-mb", "1", "--env", "BUN_WASM_STACK_KIB=800", "--env", "BUNWASM_STACK_EXPECT_CAUGHT=1"],
  });
});
