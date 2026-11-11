import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture";
import { stageSharedPrograms } from "./stage-program-profiles";

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
