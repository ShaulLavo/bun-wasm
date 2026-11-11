import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCustomSection, tagProgramCore } from "../src/engine-kind";
import { initializationPair } from "../tests/package/engine-initialization-fixture";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import type { ProgramBuildReceipt } from "./guest-core-receipt";
import { stageSharedPrograms } from "./stage-program-profiles";

const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function receipt(bytes: Uint8Array, scope: "core" | "quickjs"): ProgramBuildReceipt {
  const content = { selection: { profile: "shared-group" }, fixture: "Synthetic staging input, not producer evidence" };
  return {
    schema: 1,
    inputs: { schema: 1, scope, source: { head: (scope === "core" ? "a" : "b").repeat(40), tree: "c".repeat(40) }, content, contentSha256: hash(JSON.stringify(content)) },
    artifact: { artifactSha256: hash(bytes), artifactBytes: bytes.byteLength },
  };
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
    await stageSharedPrograms(join(source, "out"), builds, { quickjs: source, jsc: undefined });
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
