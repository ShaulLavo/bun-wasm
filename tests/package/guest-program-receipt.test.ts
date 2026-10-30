import { expect, test } from "bun:test";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureProgramInputs, parseProgramInputs, verifyProgramReceipt, type ProgramBuildReceipt } from "../../scripts/guest-core-receipt";
import { artifactIdentity } from "../../scripts/guest-build-receipt";
import { fixtureGit, withReceiptFixture } from "./guest-receipt-fixture";
import { quickjsPair } from "./quickjs-plan-fixture";
import { appendCustomSection, ENGINE_SECTION } from "../../src/engine-kind.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";

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

test("program compatibility failures report exact original and expected input identities", async () => {
  await withReceiptFixture(async options => {
    const origin = await captureProgramInputs(options, "core", { features: ["engine-split"] });
    const tagged = quickjsPair().core;
    const tagBytes = appendCustomSection(new Uint8Array(), ENGINE_SECTION, new TextEncoder().encode("quickjs")).byteLength;
    const core = tagged.subarray(0, tagged.length - tagBytes);
    const receipt = { schema: 1, inputs: origin, artifact: artifactIdentity(core) } satisfies ProgramBuildReceipt;
    const header = join(options.sysroot, "include/stdio.h");
    await writeFile(header, "changed transferred header\n");
    const expected = await captureProgramInputs(options, "core", { features: ["engine-split"] });
    let message = "";
    try { verifyProgramReceipt(core, receipt, expected); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toStartWith("Program input compatibility mismatch\n");
    const diagnostic: unknown = JSON.parse(message.slice(message.indexOf("\n") + 1));
    expect(diagnostic).toMatchObject({
      original: { source: origin.source, contentSha256: origin.contentSha256 },
      expected: { source: expected.source, contentSha256: expected.contentSha256 },
      differences: [
        { path: ["groups", "sysroot", "files", "include/stdio.h", "sha256"], original: hash("fixture\n"), expected: hash("changed transferred header\n") },
        { path: ["groups", "sysroot", "files", "include/stdio.h", "bytes"], original: 8, expected: 27 },
      ],
    });
    expect(() => verifyProgramReceipt(core.slice(1), receipt, expected)).toThrow("artifact bytes");
    await writeFile(header, "fixture\n");
    const restored = await captureProgramInputs(options, "core", { features: ["engine-split"] });
    expect(verifyProgramReceipt(core, receipt, restored)).toEqual(receipt);
  });
});

for (const path of ["scripts/transpile-runtime.ts", "scripts/generate-bun-wrap.ts", "scripts/generate-node-path.ts", "scripts/generate-direct-stream.ts", "web/src/native-direct-stream.ts", "jsc/wasi-jsc.cmake", "scripts/check-cmake-cache.cmake"]) {
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


test.each(["-I", "-isystem", "-iquote"])("absent JSC compiler search path %s is bound and later headers invalidate identity", async flag => {
  await withReceiptFixture(async options => {
    const build = options.jscBuild!;
    const missing = join(build, "webkit/Source/JavaScriptCore/bindings");
    const database = join(build, "build/jsc/compile_commands.json");
    const command = `clang++ ${flag}${flag === "-I" ? "" : " "}${missing}`;
    await writeFile(database, JSON.stringify([{ directory: join(build, "build/jsc"), file: "/fixture/jsc.cpp", command }]));
    const selected = { ...options, build: "jsc" } as const;
    const before = await captureProgramInputs(selected, "jsc");
    expect(JSON.stringify(before.content)).toContain("prebuild:webkit/Source/JavaScriptCore/bindings");
    await mkdir(missing, { recursive: true });
    await writeFile(join(missing, "appeared.h"), "new header\n");
    const appeared = await captureProgramInputs(selected, "jsc");
    expect(appeared.contentSha256).not.toBe(before.contentSha256);
    expect(JSON.stringify(appeared.content)).toContain("bindings/appeared.h");
    await writeFile(join(missing, "appeared.h"), "changed header\n");
    expect((await captureProgramInputs(selected, "jsc")).contentSha256).not.toBe(appeared.contentSha256);
  });
});

test.each(["outside", "symlink", "forced", "dangling"])("JSC header capture rejects missing %s inputs without eliding roots or required files", async kind => {
  await withReceiptFixture(async options => {
    const build = options.jscBuild!;
    let path = join(options.repository, "private/missing-headers");
    if (kind === "forced") path = join(build, "inputs/required.h");
    if (kind === "symlink" || kind === "dangling") {
      const link = join(build, "inputs/escape");
      await symlink(join(options.repository, kind === "symlink" ? "private" : "private/missing-target"), link);
      path = join(link, "missing");
    }
    const command = `clang++ ${kind === "forced" ? "-include " : "-I"}${path}`;
    await writeFile(join(build, "build/jsc/compile_commands.json"), JSON.stringify([{ directory: join(build, "build/jsc"), file: "/fixture/jsc.cpp", command }]));
    const capture = captureProgramInputs({ ...options, build: "jsc" }, "jsc");
    if (kind === "outside" || kind === "symlink") await expect(capture).rejects.toThrow("header input escapes inventoried roots");
    else await expect(capture).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("JSC compiler search-path permission failures remain fatal", async () => {
  await withReceiptFixture(async options => {
    const build = options.jscBuild!;
    const closed = join(build, "inputs/closed");
    await mkdir(closed);
    await writeFile(join(build, "build/jsc/compile_commands.json"), JSON.stringify([{ directory: join(build, "build/jsc"), file: "/fixture/jsc.cpp", command: `clang++ -I${closed}/missing` }]));
    await chmod(closed, 0);
    try { await expect(captureProgramInputs({ ...options, build: "jsc" }, "jsc")).rejects.toMatchObject({ code: "EACCES" }); }
    finally { await chmod(closed, 0o700); }
  });
});
