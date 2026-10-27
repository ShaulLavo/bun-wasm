import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureProgramInputs, parseProgramInputs, verifyProgramReceipt } from "../../scripts/guest-core-receipt";
import { artifactIdentity } from "../../scripts/guest-build-receipt";
import { fixtureGit, withReceiptFixture } from "./guest-receipt-fixture";
import { quickjsPair } from "./quickjs-plan-fixture";

for (const kind of ["quickjs", "jsc"] as const) test(`${kind} reusable side retains origin across a core-only change`, async () => {
  await withReceiptFixture(async options => {
    const selected = { ...options, build: kind };
    const origin = await captureProgramInputs(selected, kind);
    const coreBefore = await captureProgramInputs(options, "core", { features: ["engine-split"] });
    const { side } = quickjsPair(kind);
    const receipt = { schema: 1, inputs: origin, artifact: artifactIdentity(side) };
    await writeFile(join(options.repository, "crates/fixture/src/lib.rs"), "core-only change");
    fixtureGit(options.repository, "add", "crates/fixture/src/lib.rs");
    fixtureGit(options.repository, "commit", "-m", "core-only input change");
    const current = await captureProgramInputs(selected, kind);
    expect(current.source).not.toEqual(origin.source);
    expect(current.contentSha256).toBe(origin.contentSha256);
    expect(verifyProgramReceipt(side, receipt, current).inputs.source).toEqual(origin.source);
    const coreAfter = await captureProgramInputs(options, "core", { features: ["engine-split"] });
    expect(coreAfter.contentSha256).not.toBe(coreBefore.contentSha256);
    const lock = join(options.repository, "Cargo.lock");
    await writeFile(lock, (await readFile(lock, "utf8")).replace("2".repeat(64), "3".repeat(64)));
    fixtureGit(options.repository, "add", "Cargo.lock");
    fixtureGit(options.repository, "commit", "-m", "conservative workspace lock invalidation");
    const lockChanged = await captureProgramInputs(selected, kind);
    expect(() => verifyProgramReceipt(side, receipt, lockChanged)).toThrow("compatibility mismatch");
    await writeFile(join(options.repository, "crates/bunwasm-runtime/src/engine.rs"), "changed shared ABI");
    fixtureGit(options.repository, "add", "crates/bunwasm-runtime/src/engine.rs");
    fixtureGit(options.repository, "commit", "-m", "shared engine ABI change");
    const changed = await captureProgramInputs(selected, kind);
    expect(() => verifyProgramReceipt(side, receipt, changed)).toThrow("compatibility mismatch");
  });
});

test("engine identity binds actual Rust build-std sources and helper headers", async () => {
  await withReceiptFixture(async options => {
    const selected = { ...options, build: "jsc" } as const;
    const started = await captureProgramInputs(selected, "jsc");
    const source = join(options.rustSourceLib!, "std/src/lib.rs");
    const original = await readFile(source);
    await writeFile(source, "changed Rust library source");
    const changed = await captureProgramInputs(selected, "jsc");
    expect(changed.contentSha256).not.toBe(started.contentSha256);
    await writeFile(source, original);
    await writeFile(join(options.jscBuild!, "inputs/shim/wasi-compat.h"), "changed private helper header");
    const headers = await captureProgramInputs(selected, "jsc");
    expect(headers.contentSha256).not.toBe(started.contentSha256);
    const profile = join(options.jscBuild!, "build/jsc/compile_commands.json");
    await writeFile(profile, JSON.stringify([{ directory: join(options.jscBuild!, "build/jsc"), file: "/fixture/jsc.cpp",
      command: `clang++ -I${join(options.jscBuild!, "inputs")} -I${join(options.sdk, "lib/clang")} -I${join(options.sysroot, "include")}` }]));
    const explicit = await captureProgramInputs(selected, "jsc");
    expect(JSON.stringify(explicit.content)).toContain("jsc-helper-sdk-headers");
    expect(JSON.stringify(explicit.content)).toContain("jsc-helper-sysroot-headers");
  });
});

test("input and final-byte changes cannot be relabeled as reusable output", async () => {
  await withReceiptFixture(async options => {
    const inputs = await captureProgramInputs({ ...options, build: "jsc" }, "jsc");
    const { side } = quickjsPair("jsc");
    const receipt = { schema: 1, inputs, artifact: artifactIdentity(side) };
    expect(() => parseProgramInputs({ ...inputs, content: { invented: true } })).toThrow("snapshot");
    expect(() => verifyProgramReceipt(side.slice(1), receipt, inputs)).toThrow("artifact bytes");
    expect(() => verifyProgramReceipt(side, { ...receipt, inputs: { ...inputs, scope: "quickjs" } }, inputs)).toThrow("compatibility mismatch");
    expect(() => parseProgramInputs({ ...inputs, source: { ...inputs.source, head: "unrecorded" } })).toThrow("snapshot");
  });
});

for (const path of ["scripts/transpile-runtime.ts", "scripts/generate-bun-wrap.ts", "scripts/generate-node-path.ts", "jsc/wasi-jsc.cmake", "scripts/check-cmake-cache.cmake"]) {
  test(`core compatibility inventories consumed input ${path}`, async () => {
    await withReceiptFixture(async options => {
      const file = join(options.repository, path);
      await Bun.write(file, "original consumed input\n");
      fixtureGit(options.repository, "add", path);
      fixtureGit(options.repository, "commit", "-m", "consumed core input");
      const before = await captureProgramInputs(options, "core", { features: ["engine-split"] });
      const quickjs = await captureProgramInputs({ ...options, build: "quickjs" }, "quickjs");
      const jsc = await captureProgramInputs({ ...options, build: "jsc" }, "jsc");
      await writeFile(file, "changed consumed input\n");
      fixtureGit(options.repository, "add", path);
      fixtureGit(options.repository, "commit", "-m", "changed consumed core input");
      expect((await captureProgramInputs(options, "core", { features: ["engine-split"] })).contentSha256).not.toBe(before.contentSha256);
      expect((await captureProgramInputs({ ...options, build: "quickjs" }, "quickjs")).contentSha256).toBe(quickjs.contentSha256);
      const changedJsc = await captureProgramInputs({ ...options, build: "jsc" }, "jsc");
      // The JSC toolchain file is also consumed by its existing native recipe scope.
      if (path === "jsc/wasi-jsc.cmake") expect(changedJsc.contentSha256).not.toBe(jsc.contentSha256);
      else expect(changedJsc.contentSha256).toBe(jsc.contentSha256);
    });
  });
}
