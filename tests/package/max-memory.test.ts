import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { groupAddressSpaceBytes, maxMemoryBytes, parseGroupAddressSpace, parseMaxMemory, sharedGroupCoreLink, sharedGroupMaxPages, sharedGroupMemberPages,
  sharedGroupSideLink } from "../../scripts/src/program-profile.ts";
import { BUN_MEMORY_GROUP_POLICY, memoryMaximumBytes } from "../../src/engine-kind.ts";

// docs/memory-ceiling.md: two quantities, each with one authority. crates/bunwasm-cli/max-memory.txt
// is the wasm32 memory maximum of a Bun guest; crates/bunwasm-cli/group-address-space.txt is the
// address space of one shared-group memory. Every consumer derives from one of them; none keeps
// its own number.
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
  expect(sharedGroupMemberPages()).toBe(16384);
});

test("stage 2, shared groups only: the group address space is 2 GiB", () => {
  // The first value whose one-past-end address needs the sign bit; nothing above it is accepted.
  expect(groupAddressSpaceBytes()).toBe(2147483648);
  expect(sharedGroupMaxPages()).toBe(32768);
});

test("the group address space has the same bounded reader and never falls below the guest maximum", () => {
  expect(parseGroupAddressSpace("2147483648\n", 1073741824)).toBe(2147483648);
  expect(parseGroupAddressSpace("1073741824\n", 1073741824)).toBe(1073741824);
  for (const text of ["", "2147483648", "0x80000000\n", "2147483649\n", "2147549184\n", "184467440737095516161073741824\n"]) {
    expect(() => parseGroupAddressSpace(text, 65536)).toThrow(/group-address-space\.txt/);
  }
  expect(() => parseGroupAddressSpace("536870912\n", 1073741824)).toThrow(/at least the guest memory maximum/);
});

test("browser backing may be smaller than guest declarations with unchanged member allowance and stack", () => {
  // src/engine-kind.ts ships in the package and cannot read the repository at run time.
  const policy: { readonly maximumPages: number; readonly memberPages: number } = BUN_MEMORY_GROUP_POLICY;
  expect(policy.maximumPages).toBe(20480);
  expect(policy.maximumPages).toBeLessThanOrEqual(sharedGroupMaxPages());
  expect(policy.maximumPages).toBeGreaterThanOrEqual(policy.memberPages);
  expect(policy.memberPages).toBe(sharedGroupMemberPages());
  expect(BUN_MEMORY_GROUP_POLICY.stackBytes).toBe(8 << 20);
  expect(Object.keys(BUN_MEMORY_GROUP_POLICY).sort()).toEqual(["maximumPages", "memberPages", "stackBytes"]);
});

test("the authority is one line of decimal bytes, a page multiple in (0, 2 GiB]", () => {
  expect(parseMaxMemory("65536\n")).toBe(65536);
  expect(parseMaxMemory("2147483648\n")).toBe(2147483648);
  for (const text of ["", "\n", "1073741824", "1073741824\n\n", " 1073741824\n", "0x40000000\n", "1e9\n", "-65536\n",
    "0\n", "65535\n", "1073741825\n", "2147549184\n", "4294967296\n"]) {
    expect(() => parseMaxMemory(text)).toThrow(/max-memory\.txt/);
  }
});

test("the shared-group core link records the group address space once, in build.rs order", () => {
  const link = sharedGroupCoreLink();
  expect(link[0]).toBe(`--max-memory=${groupAddressSpaceBytes()}`);
  expect(link.filter(argument => argument.startsWith("--max-memory"))).toHaveLength(1);
  expect(read("crates/bunwasm-cli/shared-group-link.txt")).not.toContain("--max-memory");
});

test("the real core linker selects its maximum by explicit profile", () => {
  const build = read("crates/bunwasm-cli/build.rs");
  expect(build).toMatch(/fn declared_maximum\(\) -> u64 \{\s*if shared_group\(\) \{\s*group_address_space::GROUP_ADDRESS_SPACE_BYTES\s*\} else \{\s*max_memory::MAX_MEMORY_BYTES\s*\}\s*\}/);
  expect(build.match(/--max-memory/g)).toHaveLength(1);
  expect(build).toMatch(/"cargo:rustc-link-arg-bin=bun=--max-memory=\{\}",\s*declared_maximum\(\)/);
});

test("every shared side producer links at the group address space its receipt records", () => {
  const link = sharedGroupSideLink();
  expect(link.slice(0, 3)).toEqual(["--shared", "--shared-memory", `--max-memory=${groupAddressSpaceBytes()}`]);
  expect(link.filter(argument => argument.startsWith("--max-memory"))).toHaveLength(1);
  for (const path of ["scripts/build-engine-quickjs.sh", "scripts/build-engine-jsc.sh", "scripts/build-engine-spidermonkey-shared.sh"]) {
    const producer = read(path);
    expect(producer).toMatch(/group_address_space=\$\(bun (?:"\$root\/)?scripts\/src\/program-profile\.ts"? group-address-space\)/);
    expect(producer).toMatch(/--shared-memory "--max-memory=\$group_address_space"/);
    expect(producer).not.toMatch(/program-profile\.ts"? max-memory/);
  }
  // A split side imports its core's own unshared memory and declares no maximum.
  const receipt = read("scripts/guest-core-receipt.ts");
  expect(receipt).toContain("link: sharedGroupSideLink(), spillPointers");
  expect(receipt).toContain('link: ["--shared", "--Bsymbolic", "--no-export-dynamic"');
  for (const path of ["scripts/src/engine-explicit-init.ts", "scripts/spidermonkey-side-core-receipt.ts"]) expect(read(path)).toContain("assertSideMemory(input, profile);");
});

test("only shared-group consumers follow the group address space", () => {
  expect(read("crates/bunwasm-host/src/linked_group.rs")).toContain("crate::group_address_space::GROUP_ADDRESS_SPACE_BYTES / PAGE as u64");
  expect(read("crates/bunwasm-host/src/linked_group.rs")).toContain("member_pages: Some(MEMBER_PAGES)");
  expect(read("scripts/guest-source-manifest.ts")).toContain(".concat(sharedGroup ? GROUP_ADDRESS_SPACE_INPUTS : [])");
  // Split links, engine heap sizing and the JSC prebuild's input hash never read it, so
  // changing it cannot rebuild an engine archive.
  for (const path of ["crates/bunwasm-build/build.rs", "crates/bunwasm-tools/build.rs", "crates/bunwasm-jsc/build.rs", "crates/bunwasm-spidermonkey/build.rs",
    "crates/bunwasm-spidermonkey/src/lib.rs", "crates/bunwasm-host/src/process/stdio.rs", "jsc/common.sh", "jsc/configure.sh", "spidermonkey/build-probe-core.ts"]) {
    expect(read(path)).not.toMatch(/group.address.space/i);
  }
  const readers = tracked("group-address-space\\.txt").filter(path => !path.startsWith(".internal/") && !path.startsWith("tests/"));
  expect(readers).toEqual(["crates/bunwasm-cli/build.rs", "crates/bunwasm-cli/group_address_space.rs", "crates/bunwasm-host/src/linked_group.rs",
    "scripts/guest-source-manifest.ts", "scripts/src/program-profile.ts"]);
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
  const capacity = /536870912|512 << 20|MAX_PAGES: u64 = [0-9]|SHARED_GROUP_MAX_PAGES/;
  const nativeOracles = ["scripts/fixtures/quickjs-frame-stack.c", "scripts/fixtures/quickjs-parser-stack.c"];
  // Recorded Chrome tracing buffer statistics are evidence, not Bun guest memory ceilings.
  const traceStatistics = ["tests/performance/fixtures/lifecycle-chrome-retention.json"];
  // These standalone engine oracles set native pthread stacks, not guest memory ceilings.
  expect(tracked(capacity.source)
    .filter(path => !path.startsWith("third_party/") && !path.startsWith(".internal/"))).toEqual(nativeOracles.concat(traceStatistics));
  for (const path of nativeOracles) {
    expect(read(path).split("\n").filter(line => capacity.test(line)))
      .toEqual(["#define THREAD_STACK ((size_t)512 << 20)"]);
  }
  // The one packaged copy of the group policy, and the tests that state it.
  expect(tracked("maximumPages: (16384|20480|32768)")).toEqual(["src/engine-kind.ts", "web/tests/group-address-space.test.ts", "web/tests/playground-memory-groups.test.ts"]);
});

test("shell consumers read the maximum through the validating reader", () => {
  const result = Bun.spawnSync([process.execPath, join(ROOT, "scripts/src/program-profile.ts"), "max-memory"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("1073741824\n");
  const group = Bun.spawnSync([process.execPath, join(ROOT, "scripts/src/program-profile.ts"), "group-address-space"]);
  expect(group.exitCode).toBe(0);
  expect(group.stdout.toString()).toBe("2147483648\n");
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

// JSC reports process.memoryUsage().rss as null, so `rss < limit` never ends there and
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
  // A split core defines its memory at the guest maximum; a group core imports the group memory
  // at the group address space.
  const defined = module(section(5, [1, 1, 1].concat(leb(sharedGroupMemberPages()))));
  const imported = module(section(2, [1].concat(name("env"), name("memory"), [2, 3, 1], leb(sharedGroupMaxPages()))));
  for (const bytes of [defined, imported]) expect(WebAssembly.validate(bytes)).toBe(true);
  expect(memoryMaximumBytes(defined)).toBe(maxMemoryBytes());
  expect(memoryMaximumBytes(imported)).toBe(groupAddressSpaceBytes());
  expect(memoryMaximumBytes(module(section(5, [1, 0, 1])))).toBeUndefined();
  expect(memoryMaximumBytes(module())).toBeUndefined();
});

test("root admission reads every actual memory including non-env imports", async () => {
  const { memoryDeclarations } = await import("../../src/program-memory.ts");
  const { pages } = await import("waffle");
  const defined = module(section(5, [1, 1, 1, 3]));
  const shared = module(section(2, [1].concat(name("host"), name("private-name"), [2, 3, 1, 5])));
  for (const source of [defined, shared]) expect(WebAssembly.validate(source)).toBe(true);
  expect(memoryDeclarations(defined)).toEqual([{ kind: "private", origin: "defined", maximumPages: pages(3) }]);
  expect(memoryDeclarations(shared)).toEqual([{ kind: "shared", origin: "imported", initialPages: pages(1), maximumPages: pages(5) }]);
  expect(memoryDeclarations(module(section(5, [1, 0, 1])))).toEqual([{ kind: "private", origin: "defined", maximumPages: pages(65_536) }]);
  expect(memoryDeclarations(module())).toEqual([]);
});
