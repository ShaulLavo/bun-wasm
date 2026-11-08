import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkMessageGeneration } from "../spidermonkey/check-message-generation.ts";
import { archiveMembers, checkArchive, checkCommands, checkObject, checkRelocations, headerIdentity, supportObjectNames } from "../spidermonkey/check-build.ts";

const header = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const sdk = "/work/cache/sdk";
const sysroot = "/work/cache/sysroot";
const command = { file: "vm.cpp", arguments: [sdk + "/bin/clang++", "--sysroot", sysroot, "-fPIC", "-fno-exceptions", "-DBUNWASM_EMBED=1", "-c", "vm.cpp"] };

function archive(member: Buffer, name = "test.o/"): Buffer {
  const entry = name.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "644".padEnd(8) + String(member.length).padEnd(10) + "`\n";
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


test("recursion policy leaves ErrorNumbers data generator-safe and stays in the guarded C++ table", () => {
  const patch = readFileSync(new URL("../spidermonkey/spidermonkey-wasi.patch", import.meta.url), "utf8");
  assert(!patch.includes("+++ w/js/public/friend/ErrorNumbers.msg"), "self-hosted message data must not contain conditional policy");
  const start = patch.indexOf("+++ w/js/src/vm/ErrorMessages.cpp");
  assert(start >= 0, "missing guarded error-format policy");
  const end = patch.indexOf("diff --git", start);
  const policy = patch.slice(start, end < 0 ? undefined : end);
  assert(policy.includes("#if defined(__wasi__) && defined(BUNWASM_EMBED)"));
  assert(policy.includes("name == JSMSG_OVER_RECURSED ? JSEXN_RANGEERR : exception"));
  assert(policy.includes("#else"));
  assert(policy.includes("{#name, format, count, exception}"));
  assert(!patch.includes("JSMSG_BUNWASM_OVER_RECURSED"), "message numbering must stay unchanged");
});


test("message preflight executes the selected upstream function and rejects invalid output", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-message-preflight-"));
  try {
    const parser = join(root, "js/src/builtin/embedjs.py");
    mkdirSync(join(root, "js/src/builtin"), { recursive: true });
    mkdirSync(join(root, "js/public/friend"), { recursive: true });
    writeFileSync(join(root, "js/public/friend/ErrorNumbers.msg"), "fixture input only");
    writeFileSync(parser, 'def messages(path):\n    return "#define JSMSG_FIRST 0\\n#define JSMSG_SECOND 1"\n');
    assert.equal(checkMessageGeneration(root).messages, 2);
    writeFileSync(parser, 'def messages(path):\n    return "#define JSMSG_FIRST 0\\n#define JSMSG_FIRST 1"\n');
    assert.throws(() => checkMessageGeneration(root), /duplicate/);
    writeFileSync(parser, 'def messages(path):\n    return "invalid output"\n');
    assert.throws(() => checkMessageGeneration(root), /invalid generated/);
    writeFileSync(parser, 'def messages(path):\n    raise AssertionError("generator rejected input")\n');
    assert.throws(() => checkMessageGeneration(root), /generator rejected input/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("every target compiler recipe requires effective embed hooks", () => {
  const removed = { ...command, arguments: command.arguments.filter(arg => arg !== "-DBUNWASM_EMBED=1") };
  assert.throws(() => checkCommands([removed], sdk, sysroot), /embed/);
  for (const flags of [["-UBUNWASM_EMBED"], ["-U", "BUNWASM_EMBED"], ["-DBUNWASM_EMBED=0"]]) {
    assert.throws(() => checkCommands([{ ...command, arguments: command.arguments.concat(flags) }], sdk, sysroot), /embed/);
  }
});

test("header replay never creates or replaces missing, corrupt or changed evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-header-replay-"));
  try {
    mkdirSync(join(root, "obj/dist/include"), { recursive: true });
    mkdirSync(join(root, "receipt"));
    const header = join(root, "obj/dist/include/control.h");
    const manifest = join(root, "receipt/headers.json");
    writeFileSync(header, "original header");
    assert.throws(() => headerIdentity(root, "verify"));
    assert(!existsSync(manifest), "missing saved evidence was recreated");
    headerIdentity(root, "write");
    const original = readFileSync(manifest);
    assert.deepEqual(headerIdentity(root, "verify"), headerIdentity(root, "verify"));
    assert(readFileSync(manifest).equals(original));
    writeFileSync(manifest, "corrupt manifest");
    assert.throws(() => headerIdentity(root, "verify"));
    assert.equal(readFileSync(manifest, "utf8"), "corrupt manifest");
    writeFileSync(manifest, original);
    writeFileSync(header, "changed header");
    assert.throws(() => headerIdentity(root, "verify"));
    assert(readFileSync(manifest).equals(original), "changed headers replaced original evidence");
    assert.equal(readFileSync(header, "utf8"), "changed header");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("archive ownership reads GNU and BSD long filenames without altering member bytes", () => {
  const name = "Unified_cpp_js_src_irregexp0.o";
  const payload = Buffer.from("synthetic ownership payload only");
  const table = archive(Buffer.from(name + "/\n"), "//");
  const named = archive(payload, "/0");
  const gnu = Buffer.concat([table, named.subarray(8)]);
  assert.deepEqual(archiveMembers(gnu), [{ name, bytes: payload }]);
  const extended = archive(Buffer.concat([Buffer.from(name), payload]), `#1/${name.length}`);
  assert.deepEqual(archiveMembers(extended), [{ name, bytes: payload }]);
  assert.throws(() => archiveMembers(named), /filename index/);
});


test("the retained C2 recipe converts both experimental sides with the experimental initializer", () => {
  const recipe = readFileSync(new URL("../spidermonkey/relink-unicode-c2.sh", import.meta.url), "utf8");
  for (const name of ["base", "probe"]) {
    assert(recipe.includes(`node scripts/spidermonkey-side-core-receipt.ts convert-side "$out/${name}.implicit.wasm" "$out/${name}.wasm"`));
  }
  assert(!recipe.includes("engine-explicit-init.ts spidermonkey"));
});
