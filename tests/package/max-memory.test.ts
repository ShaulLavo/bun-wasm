import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { maxMemoryBytes, parseMaxMemory, sharedGroupCoreLink, sharedGroupMaxPages } from "../../scripts/src/program-profile.ts";

// docs/memory-ceiling.md: crates/bunwasm-cli/max-memory.txt is the one authority for the wasm32
// memory maximum. Every consumer derives from it; none keeps its own number.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function tracked(pattern: string): string[] {
  const result = Bun.spawnSync(["git", "-C", ROOT, "grep", "-l", "-E", "-e", pattern, "--", ".", ":!docs", ":!tests/package/max-memory.test.ts"]);
  if (result.exitCode > 1) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\n").filter(Boolean).sort();
}

test("stage 1: the guest memory maximum is 1 GiB", () => {
  // Raising it is a MEM02 stage of its own. Above 2 GiB, hosts must first read addresses unsigned.
  expect(maxMemoryBytes()).toBe(1073741824);
  expect(sharedGroupMaxPages()).toBe(16384);
});

test("the authority is one line of decimal bytes, a page multiple in (0, 2 GiB]", () => {
  expect(parseMaxMemory("65536\n")).toBe(65536);
  expect(parseMaxMemory("2147483648\n")).toBe(2147483648);
  for (const text of ["", "\n", "1073741824", "1073741824\n\n", " 1073741824\n", "0x40000000\n", "1e9\n", "-65536\n",
    "0\n", "65535\n", "1073741825\n", "2147549184\n", "4294967296\n"]) {
    expect(() => parseMaxMemory(text)).toThrow(/max-memory\.txt/);
  }
});

test("the shared-group link records the maximum once, in build.rs order", () => {
  const link = sharedGroupCoreLink();
  expect(link[0]).toBe(`--max-memory=${maxMemoryBytes()}`);
  expect(link.filter(argument => argument.startsWith("--max-memory"))).toHaveLength(1);
  expect(read("crates/bunwasm-cli/shared-group-link.txt")).not.toContain("--max-memory");
});

test("every consumer reads the authority", () => {
  for (const path of ["crates/bunwasm-cli/build.rs", "crates/bunwasm-build/build.rs", "crates/bunwasm-tools/build.rs", "crates/bunwasm-jsc/build.rs"]) {
    expect(read(path)).toContain("max_memory::MAX_MEMORY_BYTES");
  }
  expect(read("crates/bunwasm-host/src/linked_group.rs")).toContain("crate::max_memory::MAX_MEMORY_BYTES / PAGE as u64");
  expect(read("crates/bunwasm-host/src/process/stdio.rs")).toContain("crate::max_memory::MAX_MEMORY_BYTES as usize");
  expect(read("crates/bunwasm-host/src/process/mod.rs")).toContain("unwrap_or(stdio::DEFAULT_MEMORY_LIMIT)");
  expect(read("crates/bunwasm-jsc/cpp/helpers.cpp")).toContain("forceRAMSize() = BUN_WASM_MAX_MEMORY;");
  expect(read("jsc/configure.sh")).toContain('--max-memory=$(<"$JSC_MAX_MEMORY_FILE")');
  expect(read("jsc/common.sh")).toContain('sha256sum "$JSC_MAX_MEMORY_FILE"');
  expect(read("tests/linker/quickjs/run.sh")).toContain("--max-memory=\"$(<crates/bunwasm-cli/max-memory.txt)\"");
  expect(read("scripts/guest-source-manifest.ts")).toContain('"crates/bunwasm-cli/max-memory.txt", "crates/bunwasm-cli/max_memory.rs"');
});

test("no consumer keeps its own capacity number", () => {
  // The bash-web shell is a separate program with its own smaller memory, not a Bun guest.
  expect(tracked("--max-memory=[0-9]")).toEqual(["scripts/build-bash-web-shell.sh"]);
  expect(tracked("forceRAMSize\\(\\) = [0-9]")).toEqual([]);
  expect(tracked("536870912|512 << 20|MAX_PAGES: u64 = [0-9]|SHARED_GROUP_MAX_PAGES")
    .filter(path => !path.startsWith("third_party/") && !path.startsWith(".internal/"))).toEqual([]);
});
