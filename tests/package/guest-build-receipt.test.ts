import { expect, test } from "bun:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, writeGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { guestBuilds, hash } from "../../scripts/guest-source-manifest.ts";
import { fixtureGit, receiptCli, withCliReceiptFixture, withReceiptFixture, wasm } from "./guest-receipt-fixture.ts";

test("guest receipt binds committed repository, selected engine, consumed inputs, tools and exact final bytes", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    const receipt = await writeGuestBuildReceipt(options, artifact, inputs);
    expect(receipt.sourceManifest.source).toEqual({ head: fixtureGit(options.repository, "rev-parse", "HEAD"), tree: fixtureGit(options.repository, "rev-parse", "HEAD^{tree}") });
    expect(receipt.bunHead).toBe(fixtureGit(join(options.repository, "vendor/bun"), "rev-parse", "HEAD"));
    expect(receipt.sourceManifest.build).toBe("browser");
    expect(receipt.sourceManifest.groups.map(group => group.name)).toEqual(["repository", "bun", "boringssl", "waffle-libc", "sysroot", "sdk", "rust-target"]);
    expect(receipt.sourceManifest.groups.find(group => group.name === "bun")?.files.map(file => file.path)).toContain("build/debug/codegen/build_options.rs");
    expect(receipt.sourceManifest.tools.find(tool => tool.name === "clang")?.version).toBe("fixture tool 1");
    expect(JSON.stringify(receipt)).not.toContain("secret.txt");
    expect(receipt.sourceManifest.omissions.length).toBeGreaterThan(0);
    expect(receipt.artifactBytes).toBe(8);
    expect(receipt.sysrootReceiptSha256).toBe(hash(await readFile(join(options.sysroot, "bun-wasm-sysroot.json"))));
    expect(await Bun.file(`${artifact}.build.json`).json()).toEqual(receipt);
    expect(() => verifyGuestBuildReceipt(wasm, receipt)).not.toThrow();
    expect(() => verifyGuestBuildReceipt(wasm, { ...receipt, bunHead: "stale" })).toThrow("bunHead");
    expect(() => verifyGuestBuildReceipt(wasm, { ...receipt, artifactSha256: "0".repeat(64) })).toThrow("does not match");
    expect(() => verifyGuestBuildReceipt(new Uint8Array([1]), receipt)).toThrow("does not match");
    expect(() => verifyGuestBuildReceipt(wasm, { ...receipt, sourceManifest: { ...receipt.sourceManifest, build: "quickjs" } })).toThrow("digest mismatch");
    const { sourceManifest: _, ...oldReceipt } = receipt;
    expect(() => verifyGuestBuildReceipt(wasm, oldReceipt)).toThrow("source manifest");
  });
});

test("write command validation can pass its verified receipt as build inputs", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    const verified = { ...inputs, artifactSha256: hash(wasm), artifactBytes: wasm.byteLength };
    verifyGuestBuildReceipt(wasm, verified);
    await expect(writeGuestBuildReceipt(options, artifact, verified)).resolves.toEqual(verified);
  });
});

test("receipt CLI snapshots and writes a tiny committed source fixture without compiling", async () => {
  await withCliReceiptFixture(async fixture => {
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.stderr.toString()).toBe("");
    expect(started.exitCode).toBe(0);
    const snapshot = join(fixture.root, "dist/inputs.json");
    await writeFile(snapshot, started.stdout);
    const finished = receiptCli(fixture, "write", fixture.artifact, snapshot);
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(0);
    const receipt: unknown = await Bun.file(`${fixture.artifact}.build.json`).json();
    expect(() => verifyGuestBuildReceipt(wasm, receipt)).not.toThrow();
  });
});

test("guest build preparation rejects stale imported source without repairing it", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const vendor = join(options.repository, "vendor/bun");
    await writeFile(join(vendor, "src/input.rs"), "different committed source\n");
    fixtureGit(vendor, "commit", "-am", "different source");
    const head = fixtureGit(vendor, "rev-parse", "HEAD");
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("differs from the checked-in patch series");
    expect(fixtureGit(vendor, "rev-parse", "HEAD")).toBe(head);
    expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
  });
});

for (const path of ["crates/fixture/src/lib.rs", "patches/bun/fixture.config", "Cargo.lock"]) test(`dirty claimed repository source is rejected at ${path}`, async () => {
  await withReceiptFixture(async (options) => {
    await writeFile(join(options.repository, path), "dirty\n");
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("committed and clean");
  });
});

for (const path of ["vendor/bun/src/input.rs", "vendor/bun/build/debug/codegen/build_options.rs", "vendor/bun/vendor/lolhtml/src/lib.rs", "vendor/boringssl/crypto/input.c", "waffle/patches/wasi-libc/preopen-scan.patch", "sysroot/bun-wasm-sysroot.json", "sysroot/include/stdio.h", "sdk/VERSION", "rustlib/libstd.rlib", "fake-tool", "crates/fixture/src/lib.rs"]) test(`input drift refuses a new receipt at ${path}`, async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    await writeFile(join(options.repository, path), "changed during build\n");
    await expect(writeGuestBuildReceipt(options, artifact, inputs)).rejects.toThrow();
    expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
  });
});

test("new repository commit cannot relabel an already-started build", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    fixtureGit(options.repository, "commit", "--allow-empty", "-m", "new head, same tree");
    await expect(writeGuestBuildReceipt(options, artifact, inputs)).rejects.toThrow("changed during the build");
  });
});

test("allowlisted source symlinks cannot escape into private files", async () => {
  await withReceiptFixture(async (options) => {
    await symlink(join(options.repository, "private/secret.txt"), join(options.boringssl, "crypto/private.h"));
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("escapes allowlist");
  });
});

test("sysroot SDK overlays are hashed by content and cyclic links are rejected", async () => {
  await withReceiptFixture(async (options, artifact) => {
    await mkdir(join(options.sdk, "overlay"));
    await writeFile(join(options.sdk, "overlay/header.h"), "sdk input");
    await symlink(join(options.sdk, "overlay"), join(options.sysroot, "include/c++"));
    const inputs = await prepareGuestBuildInputs(options);
    await writeFile(join(options.sdk, "overlay/header.h"), "changed sdk overlay");
    await expect(writeGuestBuildReceipt(options, artifact, inputs)).rejects.toThrow("changed during the build");
    await symlink(options.sysroot, join(options.sysroot, "include/loop"));
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("Cyclic");
  });
});

test("artifact/build mismatch is refused without creating a sidecar", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    await expect(writeGuestBuildReceipt(options, join(options.repository, "dist/bun.wasm"), inputs)).rejects.toThrow("selected build");
    expect(await Bun.file(`${artifact}.build.json`).exists()).toBe(false);
  });
});


for (const build of ["quickjs", "quickjs-minimal", "tools", "jsc"] as const) test(`receipt records the selected ${build} build without compiling it`, async () => {
  await withReceiptFixture(async options => {
    const selected = { ...options, build };
    const artifact = join(options.repository, "dist", guestBuilds[build].artifact);
    await writeFile(artifact, wasm);
    const inputs = await prepareGuestBuildInputs(selected);
    const receipt = await writeGuestBuildReceipt(selected, artifact, inputs);
    expect(receipt.sourceManifest.build).toBe(build);
    expect(receipt.sourceManifest.groups.some(group => group.name === "jsc-prebuild")).toBe(build === "jsc" || build === "tools");
    expect(receipt.sourceManifest.groups.some(group => group.name === "boringssl")).toBe(true);
  });
});

test("assume-unchanged cannot hide a modified committed build input", async () => {
  await withReceiptFixture(async options => {
    fixtureGit(options.repository, "update-index", "--assume-unchanged", "crates/fixture/src/lib.rs");
    await writeFile(join(options.repository, "crates/fixture/src/lib.rs"), "hidden modification");
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("differs from committed source");
  });
});

test("manifest validation rejects missing tools, files, omissions and contradictory sysroot identity", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    const receipt = await writeGuestBuildReceipt(options, artifact, inputs);
    const variants = [
      { ...receipt.sourceManifest, tools: [] },
      ...["node", "rust-lld"].map(name => ({ ...receipt.sourceManifest, tools: receipt.sourceManifest.tools.filter(tool => tool.name !== name) })),
      { ...receipt.sourceManifest, groups: [] },
      { ...receipt.sourceManifest, omissions: [] },
      { ...receipt.sourceManifest, source: { head: "comparison base", tree: receipt.sourceManifest.source.tree } },
    ];
    for (const sourceManifest of variants) {
      const invalid = { ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) };
      expect(() => verifyGuestBuildReceipt(wasm, invalid)).toThrow();
    }
    expect(() => verifyGuestBuildReceipt(wasm, { ...receipt, sysrootReceiptSha256: "f".repeat(64) })).toThrow("differs from source manifest");
  });
});

test("build start refuses a sysroot receipt that names a different installed libc builder", async () => {
  await withReceiptFixture(async options => {
    await writeFile(join(options.waffle, "scripts/build-wasi-libc.sh"), "different builder");
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("does not match installed builder");
  });
});

for (const path of ["vendor/boringssl/crypto/input.c", "jsc-build/webkit/Source/JavaScriptCore/yarr/YarrPattern.cpp", "jsc-build/webkit/Source/JavaScriptCore/runtime/OptionsList.h", "jsc-build/build/jsc/JavaScriptCore/DerivedSources/yarr/YarrCanonicalizeUnicode.cpp"]) test(`tools receipt binds directly consumed native source at ${path}`, async () => {
  await withReceiptFixture(async options => {
    const selected = { ...options, build: "tools" } as const;
    const artifact = join(options.repository, "dist", guestBuilds.tools.artifact);
    await writeFile(artifact, wasm);
    const inputs = await prepareGuestBuildInputs(selected);
    await writeFile(join(options.repository, path), "changed native input");
    await expect(writeGuestBuildReceipt(selected, artifact, inputs)).rejects.toThrow("changed during the build");
  });
});
