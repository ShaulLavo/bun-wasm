import assert from "node:assert/strict";
import { test } from "bun:test";
import { checkArchive, checkCommands, checkObject, checkRelocations, supportObjectNames } from "../spidermonkey/check-build.ts";

const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const sdk = "/work/cache/sdk";
const sysroot = "/work/cache/sysroot";
const command = { file: "vm.cpp", arguments: [sdk + "/bin/clang++", "--sysroot", sysroot, "-fPIC", "-fno-exceptions", "-c", "vm.cpp"] };

function archive(member: Buffer): Buffer {
  const entry = "test.o/".padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "644".padEnd(8) + String(member.length).padEnd(10) + "`\n";
  return Buffer.concat([Buffer.from("!<arch>\n" + entry), member, Buffer.alloc(member.length % 2, 10)]);
}

test("SpiderMonkey object checks reject defined and imported exception tags", () => {
  checkObject(header);
  assert.throws(() => checkObject(Buffer.concat([header, Buffer.from([13, 1, 0])])), /exception tag section/);
  const importTag = Buffer.from([2, 8, 1, 1, 109, 1, 116, 4, 0, 0]);
  assert.throws(() => checkObject(Buffer.concat([header, importTag])), /exception tag import/);
});

test("SpiderMonkey object checks reject memory64 and non-Wasm objects", () => {
  const memory64 = Buffer.from([2, 8, 1, 1, 109, 1, 109, 2, 4, 0]);
  assert.throws(() => checkObject(Buffer.concat([header, memory64])), /wasm32/);
  assert.throws(() => checkObject(Buffer.from("LLVM bitcode")), /non-Wasm/);
  assert.throws(() => checkObject(Buffer.concat([header, Buffer.from([0, 100])])), /truncated/);
});

test("SpiderMonkey archive checks inspect members rather than only the outer header", () => {
  const custom = Buffer.from("\x00\x0e\x0d__memory_base");
  assert.equal(checkArchive(archive(Buffer.concat([header, custom]))).wasmObjects, 1);
  assert.throws(() => checkArchive(archive(Buffer.from("native object"))), /non-Wasm/);
  assert.throws(() => checkArchive(archive(header)), /PIC/);
});

test("SpiderMonkey compile checks require PIC, no exceptions and the consumer sysroot", () => {
  assert.equal(checkCommands([command], sdk, sysroot), 1);
  for (const flag of ["-fPIC", "-fno-exceptions", sysroot]) {
    const changed = { ...command, arguments: command.arguments.filter((arg) => arg !== flag) };
    assert.throws(() => checkCommands([changed], sdk, sysroot));
  }
  assert.throws(() => checkCommands([{ ...command, arguments: command.arguments.concat(["--target=wasm32-wasi"]) }], sdk, sysroot), /wasm32-wasip1/);
  assert.throws(() => checkCommands([{ ...command, arguments: command.arguments.concat(["-target", "wasm64-unknown-unknown"]) }], sdk, sysroot), /wasm32-wasip1/);
  assert.throws(() => checkCommands([{ ...command, arguments: command.arguments.concat(["-fno-PIC"]) }], sdk, sysroot), /conflicting/);
  assert.throws(() => checkCommands([], sdk, sysroot), /no target/);
});

test("SpiderMonkey relocation checks accept relative data and reject absolute code or libc state", () => {
  assert.deepEqual(checkRelocations("0x1 R_WASM_MEMORY_ADDR_REL_SLEB local 0\n0x2 R_WASM_GLOBAL_INDEX_LEB __memory_base"), {
    R_WASM_MEMORY_ADDR_REL_SLEB: 1, R_WASM_GLOBAL_INDEX_LEB: 1,
  });
  for (const kind of ["LEB", "SLEB"]) {
    assert.throws(() => checkRelocations(`0x1 R_WASM_MEMORY_ADDR_${kind} data 0`), /non-PIC/);
  }
  assert.throws(() => checkRelocations("0x1 R_WASM_MEMORY_ADDR_I32 stderr 0"), /libc-state/);
  assert.throws(() => checkRelocations(""), /no relocations/);
});


test("SpiderMonkey support archive follows the generated source recipes", () => {
  assert.deepEqual(supportObjectNames("UNIFIED_CPPSRCS := Unified_cpp_mfbt0.cpp\nCPPSRCS += $(UNIFIED_CPPSRCS)\nCPPSRCS += $(srcdir)/decimal/Decimal.cpp\n"), ["Unified_cpp_mfbt0.o", "Decimal.o"]);
  assert.throws(() => supportObjectNames("CPPSRCS += $(UNEXPECTED)\n"), /unknown support/);
});
