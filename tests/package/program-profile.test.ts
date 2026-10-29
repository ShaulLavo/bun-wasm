import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputProfile, verifyProgramReceipt, type ProgramInputSnapshot } from "../../scripts/guest-core-receipt.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { parseProgramProfile, sharedGroupEnvironment, verifySharedSysroot, verifySplitSysroot } from "../../scripts/src/program-profile.ts";
import { importedMemory, sharedGroupPair } from "../../src/engine-kind.ts";
import { quickjsPair } from "./quickjs-plan-fixture.ts";

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
