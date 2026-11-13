import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCustomSection, BUN_MEMORY_GROUP_POLICY, importedMemory, programProfile, tagProgramCore, type SupportedPairedEngine } from "../src/engine-kind";
import { initializationPair } from "../tests/package/engine-initialization-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import type { ProgramBuildReceipt } from "./guest-core-receipt";
import { sharedProgramReceipts, stageSharedPrograms } from "./stage-program-profiles";
import { verifySharedProgramMemory } from "./shared-program-memory";

const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const experimentalBacking = { ...BUN_MEMORY_GROUP_POLICY, maximumPages: 20480 };

test("host backing is smaller than both unchanged source import maxima", () => {
  const pair = initializationPair("quickjs", true);
  expect(importedMemory(pair.core)?.maximum).toBe(32768);
  expect(importedMemory(pair.side)?.maximum).toBe(32768);
  expect(BUN_MEMORY_GROUP_POLICY.maximumPages).toBe(32768);
  expect(() => verifySharedProgramMemory(pair.core, pair.side, experimentalBacking)).not.toThrow();
  expect(() => verifySharedProgramMemory(pair.core, pair.side, { ...BUN_MEMORY_GROUP_POLICY, maximumPages: 32769 })).toThrow("source memory import's limits");
  expect(() => verifySharedProgramMemory(pair.core, pair.side, { ...BUN_MEMORY_GROUP_POLICY, maximumPages: 16383 })).toThrow("member allowance");
  expect(() => verifySharedProgramMemory(pair.core, pair.side, { ...BUN_MEMORY_GROUP_POLICY, memberPages: 128 })).toThrow("layout and stack");
});

for (const component of ["core", "side"] as const) {
  test(`host backing below the ${component} import minimum is refused`, () => {
    const pair = initializationPair("quickjs", true);
    const changed = Buffer.from(pair[component]);
    const descriptor = Buffer.from([3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 3, 1, 0x80, 0x80, 2]);
    const at = changed.indexOf(descriptor);
    expect(at).toBeGreaterThanOrEqual(0);
    changed[at + descriptor.length - 4] = 127;
    expect(WebAssembly.validate(changed)).toBe(true);
    const core = component === "core" ? changed : pair.core, side = component === "side" ? changed : pair.side;
    expect(() => verifySharedProgramMemory(core, side, { maximumPages: 126, memberPages: 64, stackBytes: 65536 })).toThrow("source memory import's limits");
  });
  test(`a sufficient maximum does not hide insufficient initial backing for the ${component}`, () => {
    const pair = initializationPair("quickjs", true);
    const changed = Buffer.from(pair[component]);
    const descriptor = Buffer.from([3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 3, 1, 0x80, 0x80, 2]);
    const at = changed.indexOf(descriptor);
    expect(at).toBeGreaterThanOrEqual(0);
    changed[at + descriptor.length - 4] = 127;
    expect(WebAssembly.validate(changed)).toBe(true);
    const core = component === "core" ? changed : pair.core, side = component === "side" ? changed : pair.side;
    expect(() => verifySharedProgramMemory(core, side, { maximumPages: 20480, memberPages: 16384, stackBytes: 65536 })).toThrow("initialization backing");
  });
}

test("host backing does not accept an unshared side or a defined core memory", () => {
  const group = initializationPair("quickjs", true), split = initializationPair("quickjs");
  expect(() => verifySharedProgramMemory(group.core, split.side)).toThrow("current group address space");
  expect(() => verifySharedProgramMemory(split.core, group.side)).toThrow("current group address space");
});

function receipt(bytes: Uint8Array, scope: "core" | SupportedPairedEngine): ProgramBuildReceipt {
  const content = { selection: { profile: "shared-group" }, fixture: "Synthetic staging input, not producer evidence" };
  return {
    schema: 1,
    inputs: { schema: 1, scope, source: { head: (scope === "core" ? "a" : "b").repeat(40), tree: "c".repeat(40) }, content, contentSha256: hash(JSON.stringify(content)) },
    artifact: { artifactSha256: hash(bytes), artifactBytes: bytes.byteLength },
  };
}

async function writeSpiderMonkeyReceipts(source: string, pair: ReturnType<typeof initializationPair>, overrides: Partial<Record<"library" | "headers", unknown>> = {}) {
  const identity = (bytes: Uint8Array | string) => ({ sha256: hash(bytes), bytes: typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength });
  const library = { profile: "shared-group", library: { sha256: "d".repeat(64), bytes: 123 }, headers: { count: 1, sha256: "e".repeat(64) }, ...overrides };
  const text = JSON.stringify(library) + "\n";
  await Bun.write(join(source, "shared-group-library.json"), text);
  const coreReceipt = receipt(pair.untaggedCore, "core");
  await Bun.write(join(source, "bun-core.wasm.core.json"), JSON.stringify(coreReceipt) + "\n");
  await Bun.write(join(source, "spidermonkey-shared.json"), JSON.stringify({ schema: 1, experimental: true, profile: "shared-group",
    program: identity(pair.core), side: identity(pair.side), inputs: { source: coreReceipt.inputs.source, core: identity(pair.untaggedCore), coreReceipt,
      native: { receipt: identity(text), library: library.library, headers: library.headers } } }));
}

function invalidNativeIdentities(field: "bytes" | "count") {
  const valid = { sha256: "d".repeat(64), [field]: 1 };
  return [
    { defect: "missing", value: undefined },
    { defect: "null", value: null },
    { defect: "missing digest", value: { [field]: 1 } },
    { defect: "invalid digest", value: { ...valid, sha256: "not-a-digest" } },
    { defect: "missing size", value: { sha256: valid.sha256 } },
    { defect: "zero size", value: { ...valid, [field]: 0 } },
    { defect: "negative size", value: { ...valid, [field]: -1 } },
    { defect: "fractional size", value: { ...valid, [field]: 1.5 } },
    { defect: "unsafe size", value: { ...valid, [field]: Number.MAX_SAFE_INTEGER + 1 } },
    { defect: "string size", value: { ...valid, [field]: "1" } },
  ];
}

for (const identity of [{ name: "library", field: "bytes" }, { name: "headers", field: "count" }] as const) {
  test.each(invalidNativeIdentities(identity.field))(`SpiderMonkey staging rejects matching ${identity.name} identities with $defect before publishing`, async ({ value }) => {
    await withSharedProgram(async source => {
      const pair = initializationPair("spidermonkey", true);
      await Bun.write(join(source, "bun.wasm"), pair.core);
      await Bun.write(join(source, "spidermonkey-engine.wasm"), pair.side);
      await writeSpiderMonkeyReceipts(source, pair, { [identity.name]: value });
      const builds = { existing: "preserved" }, out = join(source, "out");
      await expect(stageSharedPrograms(out, builds, { spidermonkey: source })).rejects.toThrow("identity");
      expect(builds).toEqual({ existing: "preserved" });
      expect(existsSync(out)).toBe(false);
    });
  });
}

for (const engine of ["jsc", "spidermonkey"] as const) {
  test(`${engine} shared staging verifies original receipt bytes before publishing`, async () => {
    await withSharedProgram(async source => {
      const pair = initializationPair(engine, true), names = programProfile(engine);
      await Bun.write(join(source, "bun.wasm"), pair.core);
      await Bun.write(join(source, names.side), pair.side);
      if (engine === "spidermonkey") await writeSpiderMonkeyReceipts(source, pair);
      else await Bun.write(join(source, `${names.side}.engine.json`), JSON.stringify(receipt(pair.side, engine)));
      const builds: Record<string, string> = {};
      await stageSharedPrograms(join(source, "out"), builds, { [engine]: source });
      expect(builds).toEqual({ [`profiles/shared-group/${names.core}`]: hash(pair.core), [`profiles/shared-group/${names.side}`]: hash(pair.side) });
      for (const name of sharedProgramReceipts(engine)) expect(await Bun.file(join(source, "out/profiles/shared-group/receipts", engine, name)).bytes()).toEqual(await Bun.file(join(source, name)).bytes());
    });
  });
}

for (const defect of ["core", "side", "library", "source", "pair receipt", "core receipt"] as const) {
  test(`SpiderMonkey staging rejects changed ${defect} before publishing`, async () => {
    await withSharedProgram(async source => {
      const pair = initializationPair("spidermonkey", true);
      await Bun.write(join(source, "bun.wasm"), pair.core);
      await Bun.write(join(source, "spidermonkey-engine.wasm"), pair.side);
      await writeSpiderMonkeyReceipts(source, pair);
      const mutations = { core: ["bun.wasm", appendCustomSection(pair.core, "changed", new Uint8Array())], side: ["spidermonkey-engine.wasm", appendCustomSection(pair.side, "changed", new Uint8Array())],
        library: ["shared-group-library.json", "{}"], source: ["source.txt", "b".repeat(40)], "pair receipt": ["spidermonkey-shared.json", "{}"], "core receipt": ["bun-core.wasm.core.json", "{}"] } satisfies Record<typeof defect, [string, string | Uint8Array]>;
      const [name, data] = mutations[defect];
      await Bun.write(join(source, name), data);
      const builds = {};
      await expect(stageSharedPrograms(join(source, "out"), builds, { spidermonkey: source })).rejects.toThrow();
      expect(builds).toEqual({});
      expect(await readdir(join(source, "out")).catch(() => [])).toEqual([]);
    });
  });
}

async function withSharedProgram(run: (source: string, pair: ReturnType<typeof initializationPair>) => Promise<void>): Promise<void> {
  const source = await mkdtemp(join(tmpdir(), "bun-wasm-profile-receipt-"));
  try {
    const pair = initializationPair("quickjs", true);
    await Bun.write(join(source, "bun.wasm"), pair.core);
    await Bun.write(join(source, "quickjs.wasm"), pair.side);
    await Bun.write(join(source, "bun-core.wasm.core.json"), JSON.stringify(receipt(pair.untaggedCore, "core")) + "\n");
    await Bun.write(join(source, "quickjs.wasm.engine.json"), JSON.stringify(receipt(pair.side, "quickjs")) + "\n");
    await Bun.write(join(source, "source.txt"), "a".repeat(40) + "\n");
    await run(source, pair);
  } finally { await rm(source, { recursive: true, force: true }); }
}

async function rejectedBeforePublication(source: string): Promise<void> {
  const builds = {};
  await expect(stageSharedPrograms(join(source, "out"), builds, { quickjs: source, jsc: undefined })).rejects.toThrow();
  expect(builds).toEqual({});
  expect(await readdir(join(source, "out")).catch(() => [])).toEqual([]);
}

test("shared staging preserves verified original receipts with independently sourced core and side", async () => {
  await withSharedProgram(async (source, pair) => {
    const builds: Record<string, string> = {};
    await stageSharedPrograms(join(source, "out"), builds, { quickjs: source, jsc: undefined }, experimentalBacking);
    expect(builds).toEqual({ "profiles/shared-group/bun.wasm": hash(pair.core), "profiles/shared-group/quickjs.wasm": hash(pair.side) });
    expect(Bun.gunzipSync(await Bun.file(join(source, "out/profiles/shared-group/bun.wasm.gz")).bytes())).toEqual(pair.core);
    for (const file of ["bun-core.wasm.core.json", "quickjs.wasm.engine.json", "source.txt"]) {
      expect(await Bun.file(join(source, "out/profiles/shared-group/receipts/quickjs", file)).bytes()).toEqual(await Bun.file(join(source, file)).bytes());
    }
  });
});

for (const file of ["bun.wasm", "quickjs.wasm"] as const) {
  test(`shared staging rejects changed valid ${file} with its original receipt`, async () => {
    await withSharedProgram(async (source, pair) => {
      const changed = appendCustomSection(file === "bun.wasm" ? pair.core : pair.side, "changed-staging-input", new Uint8Array([1]));
      expect(WebAssembly.validate(changed)).toBe(true);
      await Bun.write(join(source, file), changed);
      await rejectedBeforePublication(source);
    });
  });
}

test("shared staging rejects changed untagged core bytes before the exact engine tag", async () => {
  await withSharedProgram(async (source, pair) => {
    const changed = appendCustomSection(pair.untaggedCore, "changed-core-input", new Uint8Array([1]));
    await Bun.write(join(source, "bun.wasm"), tagProgramCore(changed, "quickjs"));
    await rejectedBeforePublication(source);
  });
});

for (const scope of ["core", "quickjs"] as const) {
  const file = scope === "core" ? "bun-core.wasm.core.json" : "quickjs.wasm.engine.json";
  for (const defect of ["malformed", "input digest", "artifact digest", "artifact size", "scope", "profile"] as const) {
    test(`shared staging rejects ${scope} receipt with invalid ${defect} before publishing`, async () => {
      await withSharedProgram(async (source, pair) => {
        const original = receipt(scope === "core" ? pair.untaggedCore : pair.side, scope);
        const content = { selection: { profile: "split" } };
        const invalid = {
          malformed: {},
          "input digest": { ...original, inputs: { ...original.inputs, contentSha256: "0".repeat(64) } },
          "artifact digest": { ...original, artifact: { ...original.artifact, artifactSha256: "0".repeat(64) } },
          "artifact size": { ...original, artifact: { ...original.artifact, artifactBytes: original.artifact.artifactBytes + 1 } },
          scope: { ...original, inputs: { ...original.inputs, scope: scope === "core" ? "quickjs" : "core" } },
          profile: { ...original, inputs: { ...original.inputs, content, contentSha256: hash(JSON.stringify(content)) } },
        }[defect];
        await Bun.write(join(source, file), JSON.stringify(invalid));
        await rejectedBeforePublication(source);
      });
    });
  }
}

test("shared staging rejects a valid split pair before publishing profile assets or receipts", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-profile-stage-"));
  try {
    const pair = quickjsPair();
    await Bun.write(join(scratch, "bun.wasm"), pair.core);
    await Bun.write(join(scratch, "quickjs.wasm"), pair.side);
    const builds = {};
    await expect(stageSharedPrograms(join(scratch, "out"), builds, { quickjs: scratch, jsc: undefined })).rejects.toThrow("selected shared-group, received split");
    expect(builds).toEqual({});
    expect(await Bun.file(join(scratch, "out/profiles/shared-group/bun.wasm.gz")).exists()).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

function differentMaximum(bytes: Uint8Array, maximum: 16384 | 65536): Uint8Array<ArrayBuffer> {
  expect(importedMemory(bytes)).toEqual({ shared: true, maximum: 32768 });
  const changed = Buffer.from(bytes);
  // Exact env.memory import in the executable fixture, including its three-byte maximum.
  const entry = Buffer.from([3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 3, 1, 0x80, 0x80, 2]);
  const at = changed.indexOf(entry);
  expect(at).toBeGreaterThanOrEqual(0);
  changed[at + entry.length - 1] = maximum === 16384 ? 1 : 4;
  expect(WebAssembly.validate(changed)).toBe(true);
  expect(importedMemory(changed)).toEqual({ shared: true, maximum });
  return changed;
}

test.each([
  { component: "core", maximum: 16384 },
  { component: "side", maximum: 16384 },
  { component: "both", maximum: 16384 },
  { component: "side", maximum: 65536 },
] as const)("shared staging rejects $component at $maximum pages even with matching receipts", async ({ component, maximum }) => {
  await withSharedProgram(async (source, pair) => {
    const core = component === "side" ? pair.untaggedCore : differentMaximum(pair.untaggedCore, maximum);
    const side = component === "core" ? pair.side : differentMaximum(pair.side, maximum);
    await Bun.write(join(source, "bun.wasm"), tagProgramCore(core, "quickjs"));
    await Bun.write(join(source, "quickjs.wasm"), side);
    await Bun.write(join(source, "bun-core.wasm.core.json"), JSON.stringify(receipt(core, "core")));
    await Bun.write(join(source, "quickjs.wasm.engine.json"), JSON.stringify(receipt(side, "quickjs")));
    await expect(stageSharedPrograms(join(source, "out"), {}, { quickjs: source, jsc: undefined })).rejects.toThrow("current group address space");
    await rejectedBeforePublication(source);
  });
});

test.each([
  { component: "core", maximum: 16384 },
  { component: "side", maximum: 16384 },
  { component: "both", maximum: 16384 },
  { component: "side", maximum: 65536 },
] as const)("SpiderMonkey staging rejects $component at $maximum pages before receipt reads", async ({ component, maximum }) => {
  await withSharedProgram(async source => {
    const pair = initializationPair("spidermonkey", true);
    const untaggedCore = component === "side" ? pair.untaggedCore : differentMaximum(pair.untaggedCore, maximum);
    const side = component === "core" ? pair.side : differentMaximum(pair.side, maximum);
    const core = tagProgramCore(untaggedCore, "spidermonkey");
    await Bun.write(join(source, "bun.wasm"), core);
    await Bun.write(join(source, "spidermonkey-engine.wasm"), side);
    await writeSpiderMonkeyReceipts(source, { ...pair, core, side, untaggedCore });
    const builds = {};
    await expect(stageSharedPrograms(join(source, "out"), builds, { spidermonkey: source })).rejects.toThrow("current group address space");
    expect(builds).toEqual({});
    expect(await readdir(join(source, "out")).catch(() => [])).toEqual([]);
  });
});
