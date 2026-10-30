import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProgramInputs, engineEnvironment, inputProfile, verifyProgramReceipt, type ProgramInputSnapshot } from "../../scripts/guest-core-receipt.ts";
import { artifactIdentity } from "../../scripts/guest-build-receipt.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { parseProgramProfile, selectedCxxMembers, sharedGroupEnvironment, targetFeatures, verifySharedSysroot, verifySplitSysroot } from "../../scripts/src/program-profile.ts";
import { importedMemory, sharedGroupPair } from "../../src/engine-kind.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";
import { fixtureGit, withReceiptFixture } from "./guest-receipt-fixture.ts";

const scratches: string[] = [];
afterEach(() => {
  for (const path of scratches.splice(0)) rmSync(path, { recursive: true, force: true });
});

const J2_FLAGS = "-fPIC -matomics -mbulk-memory -mmutable-globals -DMORECORE_CONTIGUOUS=0 -DBUN_WASM_GROUP_HEAP=1";
const digest = "a".repeat(64);

function sysroot(receipt: Record<string, unknown>, libc = "shared libc"): string {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-program-profile-"));
  scratches.push(root);
  mkdirSync(join(root, "lib/wasm32-wasip1"), { recursive: true });
  writeFileSync(join(root, "lib/wasm32-wasip1/libc.a"), libc);
  writeFileSync(join(root, "bun-wasm-sysroot.json"), JSON.stringify(receipt));
  return root;
}

function sharedReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const libcSha256 = createHash("sha256").update("shared libc").digest("hex");
  return { profile: "shared-pic", growthImport: "runtime_shm.group_grow", flags: J2_FLAGS, libcSha256,
    sharedBuilderSha256: digest, groupGrowPatchSha256: digest, ...overrides };
}

test("only the J2 shared-pic sysroot with matching libc bytes builds a shared-group program", () => {
  expect(verifySharedSysroot(sysroot(sharedReceipt())).groupGrowPatchSha256).toBe(digest);
  for (const receipt of [
    sharedReceipt({ profile: undefined }),
    sharedReceipt({ growthImport: "env.sbrk" }),
    sharedReceipt({ flags: "-fPIC" }),
    sharedReceipt({ libcSha256: digest }),
  ]) expect(() => verifySharedSysroot(sysroot(receipt))).toThrow();
});

test("a split build refuses the shared-pic sysroot and accepts the default one", () => {
  expect(() => verifySplitSysroot(sysroot(sharedReceipt()))).toThrow(/default patched sysroot/);
  expect(() => verifySplitSysroot(sysroot({ libcSha256: digest }))).not.toThrow();
});

test("program profiles parse strictly and only shared-group carries atomics flags", () => {
  expect(parseProgramProfile(undefined)).toBe("split");
  expect(parseProgramProfile("shared-group")).toBe("shared-group");
  expect(() => parseProgramProfile("shared")).toThrow();
  const environment = sharedGroupEnvironment("/sysroot", "core");
  expect(environment.CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS).toContain("+atomics,+bulk-memory,+mutable-globals");
  expect(environment.CFLAGS_wasm32_wasip1).toBe("--sysroot=/sysroot -fPIC -matomics -mbulk-memory -mmutable-globals");
  expect(environment.BUN_WASM_PROGRAM_PROFILE).toBe("shared-group");
});

function snapshot(selection: Record<string, unknown>): ProgramInputSnapshot {
  const content = { selection, command: {} };
  return { schema: 1, scope: "quickjs", source: { head: "1".repeat(40), tree: "2".repeat(40) }, content, contentSha256: hash(JSON.stringify(content)) };
}

test("a receipt of one program profile never verifies against the other", () => {
  const { side } = quickjsPair();
  const split = snapshot({ kind: "quickjs" });
  const shared = snapshot({ kind: "quickjs", profile: "shared-group" });
  expect(inputProfile(split)).toBe("split");
  expect(inputProfile(shared)).toBe("shared-group");
  const artifact = { artifactSha256: hash(side), artifactBytes: side.byteLength };
  expect(verifyProgramReceipt(side, { schema: 1, inputs: shared, artifact }, shared).inputs.contentSha256).toBe(shared.contentSha256);
  expect(() => verifyProgramReceipt(side, { schema: 1, inputs: shared, artifact }, split)).toThrow(/profile mismatch/);
  expect(() => verifyProgramReceipt(side, { schema: 1, inputs: split, artifact }, shared)).toThrow(/profile mismatch/);
  // A forged split digest over shared-group content still fails on the explicit profile check.
  const forged = { ...shared, contentSha256: split.contentSha256 };
  expect(() => verifyProgramReceipt(side, { schema: 1, inputs: forged, artifact }, split)).toThrow();
});

/** A module whose only content is an `env.memory` import with these limits. */
function memoryImport(limits: number[]): Uint8Array<ArrayBuffer> {
  const label = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const entry = [1].concat(label("env"), label("memory"), [2], limits);
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 2, entry.length].concat(entry));
}

test("a pair's halves must agree on the program profile", () => {
  const { core, side } = quickjsPair();
  const split = new WebAssembly.Module(core);
  expect(importedMemory(side)).toEqual({ shared: false, maximum: undefined });
  expect(sharedGroupPair(split, side)).toBe(false);
  const sharedSide = memoryImport([3, 1, 0x80, 0x40]);
  expect(WebAssembly.validate(sharedSide)).toBe(true);
  expect(importedMemory(sharedSide)).toEqual({ shared: true, maximum: 8192 });
  expect(() => sharedGroupPair(split, sharedSide)).toThrow(/different program profiles/);
  expect(importedMemory(memoryImport([1, 1, 2]))).toEqual({ shared: false, maximum: 2 });
});

test("the core link map names each selected C++ runtime member once", () => {
  const map = [
    "      1a2b     40     1 /sdk/noeh/libc++abi.a(stdlib_new_delete.cpp.o):(_Znwm)",
    "      1a6b     20     1 /sdk/noeh/libc++abi.a(stdlib_new_delete.cpp.o):(_ZdlPvm)",
    "      2000     80     1 /sdk/noeh/libc++.a(string.cpp.o):(.text)",
    "      3000     10     1 /sysroot/lib/wasm32-wasip1/libc.a(dlmalloc.c.obj):(malloc)",
  ].join("\n");
  expect(selectedCxxMembers(map)).toEqual([
    { archive: "/sdk/noeh/libc++abi.a", member: "stdlib_new_delete.cpp.o" },
    { archive: "/sdk/noeh/libc++.a", member: "string.cpp.o" },
  ]);
});

test("object target features keep their allow and disallow prefixes", () => {
  const label = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const payload = label("target_features").concat([2, 43], label("atomics"), [45], label("shared-mem"));
  const object = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 0, payload.length].concat(payload));
  expect(targetFeatures(object)).toEqual(["+atomics", "-shared-mem"]);
  expect(targetFeatures(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]))).toEqual([]);
});

/** Run `action` with the shared-group compiler environment the capture requires, then restore. */
async function withSharedEnvironment<T>(sysroot: string, kind: "core" | "quickjs", action: () => Promise<T>): Promise<T> {
  const environment = sharedGroupEnvironment(sysroot, kind);
  const saved = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  try {
    return await action();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

for (const [kind, path] of [["core", "scripts/src/engine-explicit-init.ts"], ["core", "scripts/src/program-profile.ts"], ["quickjs", "scripts/src/program-profile.ts"]] as const) {
  test(`a retained shared-group ${kind} output is refused after ${path} changes`, async () => {
    await withReceiptFixture(async options => {
      const fixture = hash("fixture\n");
      writeFileSync(join(options.sysroot, "bun-wasm-sysroot.json"), JSON.stringify({ builderSha256: fixture, patchSha256: fixture, libcSha256: fixture,
        sdkVersion: "fixture\n", profile: "shared-pic", growthImport: "runtime_shm.group_grow", flags: J2_FLAGS, sharedBuilderSha256: digest, groupGrowPatchSha256: digest }));
      mkdirSync(join(options.repository, "scripts/src"), { recursive: true });
      writeFileSync(join(options.repository, path), "export {};\n");
      fixtureGit(options.repository, "add", path);
      fixtureGit(options.repository, "commit", "-m", "shared-group helper");
      const capture = () => withSharedEnvironment(options.sysroot, kind, () => kind === "core"
        ? captureProgramInputs(options, "core", { features: ["engine-split"], profile: "shared-group" })
        : captureProgramInputs({ ...options, build: "quickjs" }, "quickjs", undefined, "shared-group"));
      const origin = await capture();
      expect(inputProfile(origin)).toBe("shared-group");
      const { core, side } = quickjsPair();
      // A retained core receipt names the untagged generic core: drop the appended engine tag
      // section (id, size, name length, "bun-wasm-engine", "quickjs").
      const bytes = kind === "core" ? core.slice(0, core.length - (3 + "bun-wasm-engine".length + "quickjs".length)) : side;
      const receipt = { schema: 1, inputs: origin, artifact: artifactIdentity(bytes) };
      writeFileSync(join(options.repository, path), "export const changed = 1;\n");
      fixtureGit(options.repository, "add", path);
      fixtureGit(options.repository, "commit", "-m", "changed shared-group helper");
      const changed = await capture();
      expect(changed.contentSha256).not.toBe(origin.contentSha256);
      expect(() => verifyProgramReceipt(bytes, receipt, changed)).toThrow("compatibility mismatch");
    });
  });
}

test("only the QuickJS engine is qualified for the shared-group profile", () => {
  expect(engineEnvironment("quickjs", "/sysroot", "shared-group").BUN_WASM_PROGRAM_PROFILE).toBe("shared-group");
  for (const engine of ["jsc", "hermes"] as const) {
    expect(() => engineEnvironment(engine, "/sysroot", "shared-group")).toThrow(/not qualified/);
    expect(engineEnvironment(engine, "/sysroot").BUN_WASM_PROGRAM_PROFILE).toBeUndefined();
  }
});

// Source-contract checks only: these do not build or qualify a shared-group guest.
const cliBuild = readFileSync(new URL("../../crates/bunwasm-cli/build.rs", import.meta.url), "utf8");

function cliBuildFunction(name: string): string {
  const body = new RegExp(`^fn ${name}\\([^]*?^}`, "m").exec(cliBuild)?.[0];
  if (!body) throw new Error(`Missing CLI build function ${name}`);
  return body;
}

test("both core C objects use the exact opt-in profile flags and preserve default flags", () => {
  expect(cliBuildFunction("entry_flags")).toMatch(/if shared_group\(\) \{\s*&\["-fPIC", "-matomics", "-mbulk-memory", "-mmutable-globals"\]\s*} else \{\s*&\[\]\s*}/);
  for (const name of ["split_entry", "memory_telemetry", "shared_cxx_runtime"]) {
    const body = cliBuildFunction(name);
    expect(body).toContain('std::process::Command::new(compiler)');
    expect(body).toContain('"--target=wasm32-wasip1"');
    expect(body).toContain('"--sysroot={sysroot}"');
    expect(body).toContain('"-O2"');
    expect(body).toContain('"-c"');
    expect(body).toMatch(/\.args\(entry_flags\(\)\)\s*\.arg\(&source\)/);
  }
  expect(cliBuildFunction("memory_telemetry")).toContain('"-fno-builtin"');
});

test("only a shared-group core defines its C++ runtime overrides, for exactly BoringSSL's two references", () => {
  expect(cliBuildFunction("shared_group_link")).toMatch(/-Map=\{map\}"\);\s*shared_cxx_runtime\(\);\s*}$/);
  for (const name of ["main", "split_entry", "memory_telemetry"]) expect(cliBuildFunction(name)).not.toContain("shared_cxx_runtime");
  const source = readFileSync(new URL("../../crates/bunwasm-cli/cxx-runtime.c", import.meta.url), "utf8");
  expect(Array.from(source.matchAll(/__asm__\("([^"]+)"\)/g), match => match[1]).toSorted()).toEqual(["_ZNSt3__222__libcpp_verbose_abortEPKcz", "_ZdlPvm"]);
});

test("a shared-group core links no C++ runtime archive, so the override object resolves BoringSSL wherever it sits", () => {
  const crypto = readFileSync(new URL("../../crates/bunwasm-crypto-sys/build.rs", import.meta.url), "utf8");
  const link = /fn link_cxx_runtime\(self\) \{[^]*?\n    \}/.exec(crypto)?.[0];
  if (!link) throw new Error("Missing link_cxx_runtime");
  expect(link).toMatch(/Self::Split => &\["static=c\+\+", "static=c\+\+abi"\]/);
  expect(link).toMatch(/Self::SharedGroup => &\[\]/);
  expect(link).not.toContain("libc++");
});

test("a shared-group core exports no linker stack or heap layout; split keeps every export", () => {
  const layout = /const GROUP_HOST_LAYOUT: \[&str; 4\] = \[([^\]]*)\]/.exec(cliBuild)?.[1];
  if (!layout) throw new Error("Missing GROUP_HOST_LAYOUT");
  expect(Array.from(layout.matchAll(/"([^"]+)"/g), match => match[1])).toEqual(["__stack_pointer", "__stack_low", "__stack_high", "__heap_base"]);
  expect(cliBuildFunction("split_entry")).toMatch(/if shared_group\(\) && GROUP_HOST_LAYOUT\.contains\(&name\) \{\s*continue;\s*\}/);
  const exports = readFileSync(new URL("../../scripts/quickjs-core-exports.txt", import.meta.url), "utf8").split("\n");
  for (const name of ["__stack_low", "__stack_high", "__heap_base"]) expect(exports).toContain(name);
});

test("core errno goes through wasi-libc's accessor, never a plain declaration of a thread-local", () => {
  for (const path of ["crates/bunwasm-glue/src/extra.rs", "crates/bunwasm-posix/src/lib.rs"]) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/static\s+(mut\s+)?errno\b/);
    expect(source).toContain("fn __errno_location() -> *mut c_int;");
  }
});

test("a shared-group QuickJS side defines std's thread-local errno and wraps each errno-setting core call std makes", () => {
  const script = readFileSync(new URL("../../scripts/build-engine-quickjs.sh", import.meta.url), "utf8");
  const list = /group_errno_wraps=\(([^)]*)\)\n    link_profile=\(--shared-memory\)/.exec(script)?.[1];
  if (!list) throw new Error("Missing shared-group errno wraps");
  const wraps = list.split(" ");
  expect(wraps).toEqual(["write", "writev", "clock_gettime", "getcwd"]);
  expect(script).toMatch(/split\) ;;/);
  expect(script).toMatch(/for name in "\$\{group_errno_wraps\[@\]\}"; do link_profile\+=\("--wrap=\$name"\); done/);
  expect(script).toContain('error: side std imports errno-setting core functions without an errno wrap');
  expect(script).toContain('"$out/engine-init.o" "${group_objects[@]}" "$archive"');
  const shim = readFileSync(new URL("../../crates/bunwasm-engine-quickjs/group-errno.c", import.meta.url), "utf8");
  expect(shim).toMatch(/^_Thread_local int errno;$/m);
  expect(Array.from(shim.matchAll(/^\S[^;=]*?\b__wrap_(\w+)\(/gm), match => match[1])).toEqual(wraps);
  expect(Array.from(shim.matchAll(/^\S[^;=]*?\b__real_(\w+)\(/gm), match => match[1])).toEqual(wraps);
});

test("telemetry remains unconditional for both link profiles with every allocator wrapper", () => {
  const main = cliBuildFunction("main");
  expect(main).toMatch(/memory_telemetry\(\);\s*if shared_group\(\) \{\s*shared_group_link\(\);\s*} else \{/);
  expect(main.indexOf("memory_telemetry();")).toBeLessThan(main.indexOf('CARGO_FEATURE_ENGINE_SPLIT'));
  for (const flag of ["-zstack-size=8388608", "--max-memory=536870912", "--export-table", "--growable-table"]) {
    expect(main).toContain(`cargo:rustc-link-arg-bin=bun=${flag}`);
  }
  const telemetry = cliBuildFunction("memory_telemetry");
  for (const name of ["malloc", "calloc", "realloc", "free", "aligned_alloc", "posix_memalign", "__libc_malloc", "__libc_calloc", "__libc_free"]) {
    expect(telemetry).toContain(`"${name}"`);
  }
  expect(telemetry).toContain('cargo:rustc-link-arg-bin=bun=--wrap={name}');
  expect(telemetry).toContain('cargo:rustc-link-arg-bin=bun=--export=bun_memory_telemetry');
});
