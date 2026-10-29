import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, verifyGuestCompanions, writeGuestBuildReceipt, artifactIdentity } from "../../scripts/guest-build-receipt.ts";
import { captureProgramInputs, engineEnvironment, record } from "../../scripts/guest-core-receipt.ts";
import { receiptCli, withCliReceiptFixture, withReceiptFixture } from "./guest-receipt-fixture.ts";
import { sharedQuickjsPair } from "./quickjs-plan-fixture.ts";

const flags = "-fPIC -matomics -mbulk-memory -mmutable-globals -DMORECORE_CONTIGUOUS=0 -DBUN_WASM_GROUP_HEAP=1";
async function sharedSysroot(path: string): Promise<void> {
  const receipt = JSON.parse(await readFile(join(path, "bun-wasm-sysroot.json"), "utf8"));
  await writeFile(join(path, "bun-wasm-sysroot.json"), JSON.stringify({ ...receipt, profile: "shared-pic", flags, growthImport: "runtime_shm.group_grow", sharedBuilderSha256: "a".repeat(64), groupGrowPatchSha256: "b".repeat(64) }));
}
function restore(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
async function environment<T>(path: string, run: () => Promise<T>): Promise<T> {
  const values = engineEnvironment("quickjs", path, "shared-group");
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { restore(saved); }
}

test("shared compose passes its explicit profile to original side capture and preserves the side receipt", async () => {
  await withReceiptFixture(async options => {
    await sharedSysroot(options.sysroot);
    await environment(options.sysroot, async () => {
      const selected = { ...options, build: "quickjs" as const };
      const inputs = await prepareGuestBuildInputs(selected, "shared-group");
      expect(inputs.profile).toBe("shared-group");
      const { core, side } = sharedQuickjsPair();
      const path = join(options.repository, "dist/bun.wasm");
      const sidePath = join(options.repository, "dist/quickjs.wasm");
      await writeFile(path, core); await writeFile(sidePath, side);
      const sideInputs = await captureProgramInputs(selected, "quickjs", undefined, "shared-group");
      const original = JSON.stringify({ schema: 1, inputs: sideInputs, artifact: artifactIdentity(side) });
      await writeFile(`${sidePath}.engine.json`, original);
      const receipt = await writeGuestBuildReceipt(selected, path, inputs);
      expect(receipt.profile).toBe("shared-group");
      expect(() => verifyGuestBuildReceipt(core, receipt)).not.toThrow();
      await expect(verifyGuestCompanions(receipt, join(options.repository, "dist"))).resolves.toBeUndefined();
      expect(await readFile(`${sidePath}.engine.json`, "utf8")).toBe(original);
      expect(() => verifyGuestBuildReceipt(core, { ...receipt, profile: undefined })).toThrow(/profile/);
      await expect(prepareGuestBuildInputs(selected)).rejects.toThrow(/profile differs/);
      await expect(prepareGuestBuildInputs({ ...options, build: "hermes" }, "shared-group")).rejects.toThrow(/Only QuickJS/);
    });
  });
});

test("shared guest receipt CLI requires explicit profile and refuses a write-time override", async () => {
  await withCliReceiptFixture(async fixture => {
    const sysroot = fixture.env.BUN_WASM_SYSROOT!;
    await sharedSysroot(sysroot);
    Object.assign(fixture.env, engineEnvironment("quickjs", sysroot, "shared-group"));
    const started = receiptCli(fixture, "inputs", "quickjs", "shared-group");
    expect(started.exitCode, started.stderr.toString()).toBe(0);
    expect(JSON.parse(started.stdout.toString()).profile).toBe("shared-group");
    expect(receiptCli(fixture, "inputs", "quickjs").exitCode).not.toBe(0);
    const snapshot = join(fixture.root, "dist/shared-inputs.json");
    await writeFile(snapshot, started.stdout);
    const path = join(fixture.root, "dist/bun.wasm");
    const pair = sharedQuickjsPair();
    await writeFile(path, pair.core);
    const side = join(fixture.root, "dist/quickjs.wasm");
    await writeFile(side, pair.side);
    const captured = Bun.spawnSync([process.execPath, join(fixture.root, "scripts/guest-engine-receipt.ts"), "inputs", "quickjs", "shared-group"], { cwd: fixture.root, env: fixture.env });
    expect(captured.exitCode, captured.stderr.toString()).toBe(0);
    const original = JSON.stringify({ schema: 1, inputs: JSON.parse(captured.stdout.toString()), artifact: artifactIdentity(pair.side) });
    await writeFile(`${side}.engine.json`, original);
    const written = receiptCli(fixture, "write", path, snapshot);
    expect(written.exitCode, written.stderr.toString()).toBe(0);
    const receipt: unknown = await Bun.file(`${path}.build.json`).json();
    expect(() => verifyGuestBuildReceipt(pair.core, receipt)).not.toThrow();
    expect(await readFile(`${side}.engine.json`, "utf8")).toBe(original);
    expect(receiptCli(fixture, "write", path, snapshot, "split").exitCode).not.toBe(0);
    expect(receiptCli(fixture, "inputs", "jsc", "shared-group").exitCode).not.toBe(0);
  });
});

test("shared core records build-std sources even though its generic source options use browser", async () => {
  await withReceiptFixture(async options => {
    await sharedSysroot(options.sysroot);
    await environment(options.sysroot, async () => {
      const selection = { features: ["engine-split"], profile: "shared-group" };
      const before = await captureProgramInputs(options, "core", selection);
      if (!record(before.content) || !Array.isArray(before.content.groups)) throw Error("Missing captured groups");
      expect(before.content.groups.some(group => group.name === "rust-build-std")).toBe(true);
      await writeFile(join(options.rustSourceLib!, "Cargo.toml"), "changed Rust standard library input\n");
      const after = await captureProgramInputs(options, "core", selection);
      expect(after.contentSha256).not.toBe(before.contentSha256);
    });
  });
});
