import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maxMemoryBytes, parseMaxMemory, sharedGroupCoreLink, sharedGroupMaxPages } from "../../scripts/src/program-profile.ts";
import { memoryMaximumBytes } from "../../src/engine-kind.ts";

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
  expect(read("jsc/configure.sh")).toContain('max_memory=$(bun "$REPO/scripts/src/program-profile.ts" max-memory)');
  expect(read("jsc/configure.sh")).toContain("-Wl,--max-memory=$max_memory");
  expect(read("jsc/common.sh")).toContain('sha256sum "$JSC_MAX_MEMORY_FILE"');
  expect(read("tests/linker/quickjs/run.sh")).toContain("max_memory=$(bun scripts/src/program-profile.ts max-memory)");
  expect(read("tests/linker/quickjs/run.sh")).toContain('-Wl,--max-memory="$max_memory"');
  expect(read("scripts/guest-source-manifest.ts")).toContain('"crates/bunwasm-cli/max-memory.txt", "crates/bunwasm-cli/max_memory.rs"');
});

test("no consumer keeps its own capacity number", () => {
  // Separate programs with their own smaller memory, not Bun guests: the bash-web shell, the
  // shared sysroot's synthetic C proof member and the allocator telemetry test's C object.
  expect(tracked("--max-memory=[0-9]")).toEqual(["scripts/build-bash-web-shell.sh", "scripts/test-shared-sysroot.sh", "tests/memory-telemetry.test.ts"]);
  expect(tracked("forceRAMSize\\(\\) = [0-9]")).toEqual([]);
  expect(tracked("536870912|512 << 20|MAX_PAGES: u64 = [0-9]|SHARED_GROUP_MAX_PAGES")
    .filter(path => !path.startsWith("third_party/") && !path.startsWith(".internal/"))).toEqual([]);
});

test("shell consumers read the maximum through the validating reader", () => {
  const result = Bun.spawnSync([process.execPath, join(ROOT, "scripts/src/program-profile.ts"), "max-memory"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("1073741824\n");
});

// jsc/configure.sh's refusal is in scripts/engine-producer.test.ts, beside its other recipe checks.
test("the QuickJS linker test refuses an out-of-range maximum before anything else", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-max-memory-"));
  try {
    for (const path of ["tests/linker/quickjs/run.sh", "scripts/src/program-profile.ts"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(ROOT, path), join(root, path));
    }
    writeFileSync(join(root, "env.sh"), "");
    mkdirSync(join(root, "crates/bunwasm-cli"), { recursive: true });
    const run = (value: string) => {
      writeFileSync(join(root, "crates/bunwasm-cli/max-memory.txt"), value);
      const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root };
      return Bun.spawnSync(["bash", join(root, "tests/linker/quickjs/run.sh")], { cwd: root, env });
    };
    for (const value of ["2147549184\n", "184467440737095516161073741824\n"]) {
      const refused = run(value);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.toString()).toContain("max-memory.txt must be a page multiple in (0, 2 GiB]");
      expect(refused.stderr.toString()).not.toContain("QUICKJS_BUILD_DIR");
    }
    // A valid maximum passes the reader and stops at the next requirement.
    expect(run("1073741824\n").stderr.toString()).toContain("Set QUICKJS_BUILD_DIR");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// JSC (and Hermes) report process.memoryUsage().rss as null, so `rss < limit` never ends there and
// the ballast filled the whole 1 GiB on JSC. The fixture measures the one linear memory instead.
test("the high-address fixture stops on the shared linear memory, not an engine's rss", () => {
  const fixture = read("tests/fixtures/strings-above-512mib/index.ts");
  expect(fixture).not.toMatch(/memoryUsage\(\)\.rss\s*[<>]/);
  expect(fixture).toContain("while (linearMemoryBytes() < 560 * MiB)");
  expect(read("crates/bunwasm-runtime/src/natives.rs")).toContain('t.add("linearMemoryBytes"');
  expect(read("crates/bunwasm-runtime/src/js/builtins.js")).toContain("linearMemoryBytes: () => native.linearMemoryBytes()");
});

const leb = (value: number): number[] => value < 0x80 ? [value] : [(value & 0x7f) | 0x80].concat(leb(value >>> 7));
const section = (id: number, payload: number[]) => [id].concat(leb(payload.length), payload);
const name = (text: string) => leb(text.length).concat(Array.from(new TextEncoder().encode(text)));
const module = (...sections: number[][]) => Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(...sections));

// Allocator telemetry reports the linked core's own declared maximum, never a constant of its own.
test("memory telemetry's limit is the core's declared maximum", () => {
  const pages = sharedGroupMaxPages();
  const defined = module(section(5, [1, 1, 1].concat(leb(pages))));
  const imported = module(section(2, [1].concat(name("env"), name("memory"), [2, 3, 1], leb(pages))));
  for (const bytes of [defined, imported]) {
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(memoryMaximumBytes(bytes)).toBe(maxMemoryBytes());
  }
  expect(memoryMaximumBytes(module(section(5, [1, 0, 1])))).toBeUndefined();
  expect(memoryMaximumBytes(module())).toBeUndefined();
  expect(read("web/src/bun-executor.ts")).toContain("memoryMaximumBytes(req.linkPlan.core.source) ?? null");
  expect(read("web/src/memory-telemetry.ts")).toContain("memoryLimitBytes: allocator ? limitBytes : null");
});
