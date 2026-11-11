import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureSourceManifest } from "./guest-source-manifest";
import { jscArtifactInventory, packJscArtifact } from "./ci-jsc-artifact";
import { excludedJscSentinels, excludedSharedSentinels, seedJscArtifact } from "./fixtures/jsc-artifact";
import { withReceiptFixture } from "../tests/package/guest-receipt-fixture";

for (const profile of ["split", "shared-group"] as const) {
  test(`${profile} compact archive preserves the same producer's qualified source groups`, async () => {
    await withReceiptFixture(async options => {
      const root = options.jscBuild!;
      seedJscArtifact(root, profile === "shared-group");
      symlinkSync("../../icu/prefix/include", join(root, "build/jsc/icu-headers"));
      symlinkSync(join(options.sdk, "lib/clang"), join(root, "shim/sdk-headers"));
      const database = join(root, "build/jsc/compile_commands.json");
      const commands = readFileSync(database, "utf8").replace("clang++ ", `clang++ -I${options.sdk}/lib/clang -isystem ${options.sysroot}/include `);
      writeFileSync(database, commands);
      const before = await captureSourceManifest({ ...options, build: "jsc" }, "jsc");
      const toolsBefore = await captureSourceManifest({ ...options, build: "tools" });
      const archive = join(options.repository, "private/prebuild.tar.zst");
      packJscArtifact({ root, profile, sdk: options.sdk, sysroot: options.sysroot }, archive);
      // This is a synthetic receipt/transport fixture, with no JSC compilation claim.
      const producer = join(options.repository, "private/producer");
      renameSync(root, producer);
      execFileSync("bash", ["-euo", "pipefail", "-c", 'zstd -dc "$1" | tar -C "$2" -xf -', "import", archive, options.repository]);
      const after = await captureSourceManifest({ ...options, build: "jsc" }, "jsc");
      const toolsAfter = await captureSourceManifest({ ...options, build: "tools" });
      expect(after).toEqual(before);
      expect(toolsAfter).toEqual(toolsBefore);
      expect(JSON.stringify(after.groups)).toContain("JSCBuiltins.cpp.obj");
      expect(JSON.stringify(after.groups)).toContain("headers.hmap");
      const excluded = excludedJscSentinels.concat(profile === "shared-group" ? excludedSharedSentinels : []);
      for (const path of excluded) {
        expect(existsSync(join(root, path))).toBe(false);
        expect(existsSync(join(producer, path))).toBe(true);
      }
      expect(existsSync(join(root, "build/jsc/absent-search"))).toBe(false);
    });
  });
}

const missingRequired = [".bunwasm-artifacts", "build/jsc/.bunwasm-inputs", "build/jsc/lib/libWTF.a", "build/jsc/CMakeFiles/4.4.5/CMakeCXXCompiler.cmake", "webkit/.git/index", "webkit/.git/info/sparse-checkout", "inputs/shim/wasi-compat.h", "icu/prefix/include", "jsc.wasm"];
for (const path of missingRequired) {
  test(`compact inventory rejects missing required ${path}`, async () => {
    await withReceiptFixture(async options => {
      const root = options.jscBuild!;
      seedJscArtifact(root);
      rmSync(join(root, path), { recursive: true });
      expect(() => jscArtifactInventory({ root, profile: "split", sdk: options.sdk, sysroot: options.sysroot })).toThrow();
    });
  });
}

const badHeaders = ["-I{root}/icu/host-src", "-I{root}", "-isystem {root}/libcxx/llvm-project", "-isystem{root}/icu/host-src", "-include {root}/icu/data/sentinel", "-include {root}/inputs/missing.h"];
for (const flag of badHeaders) {
  test(`compact inventory rejects referenced excluded or required header ${flag}`, async () => {
    await withReceiptFixture(async options => {
      const root = options.jscBuild!;
      seedJscArtifact(root, true);
      writeFileSync(join(root, "build/jsc/compile_commands.json"), JSON.stringify([{ directory: root, file: `${root}/webkit/Source/JavaScriptCore/jsc.cpp`, command: `clang++ ${flag.replaceAll("{root}", root)}` }]));
      expect(() => jscArtifactInventory({ root, profile: "shared-group", sdk: options.sdk, sysroot: options.sysroot })).toThrow();
    });
  });
}

for (const target of ["../../icu/host-src", "../../libcxx/build", "../../icu", "../../missing", "../../private/secret.txt"]) {
  test(`compact inventory rejects retained symlink dependency ${target}`, async () => {
    await withReceiptFixture(async options => {
      const root = options.jscBuild!;
      seedJscArtifact(root, true);
      symlinkSync(target, join(root, "build/jsc/invalid-link"));
      expect(() => jscArtifactInventory({ root, profile: "shared-group", sdk: options.sdk, sysroot: options.sysroot })).toThrow();
    });
  });
}

test("an excluded intermediate symlink cannot point back into retained headers", async () => {
  await withReceiptFixture(async options => {
    const root = options.jscBuild!;
    seedJscArtifact(root);
    symlinkSync("../../prefix/include", join(root, "icu/host-src/source/headers"));
    symlinkSync("../../icu/host-src/source/headers", join(root, "build/jsc/headers"));
    expect(() => jscArtifactInventory({ root, profile: "split", sdk: options.sdk, sysroot: options.sysroot })).toThrow("excluded tree");
  });
});

test("missing shared libcxx completion is rejected before packing", async () => {
  await withReceiptFixture(async options => {
    const root = options.jscBuild!;
    seedJscArtifact(root, true);
    rmSync(join(root, "libcxx/.bunwasm-archives"));
    expect(() => jscArtifactInventory({ root, profile: "shared-group", sdk: options.sdk, sysroot: options.sysroot })).toThrow();
  });
});

test("stamp members and symlinks outside the consumer roots fail closed", async () => {
  await withReceiptFixture(async options => {
    const root = options.jscBuild!;
    seedJscArtifact(root);
    writeFileSync(join(root, ".bunwasm-artifacts"), `${"a".repeat(64)}  ${root}/icu/data/sentinel\n`);
    expect(() => jscArtifactInventory({ root, profile: "split", sdk: options.sdk, sysroot: options.sysroot })).toThrow("excluded tree");
    seedJscArtifact(root);
    symlinkSync(join(options.repository, "private/secret.txt"), join(root, "build/jsc/external-header"));
    expect(() => jscArtifactInventory({ root, profile: "split", sdk: options.sdk, sysroot: options.sysroot })).toThrow("escapes");
  });
});

test("compact import preserves blobless sparse WebKit's real offline patch verification", async () => {
  await withReceiptFixture(async options => {
    const root = options.jscBuild!;
    seedJscArtifact(root);
    const webkit = join(root, "webkit");
    rmSync(join(webkit, ".git"), { recursive: true });
    mkdirSync(join(webkit, "LayoutTests"));
    writeFileSync(join(webkit, "LayoutTests/unused.html"), "never transferred as a checkout blob\n");
    writeFileSync(join(webkit, "Source/patch-probe.h"), "original\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", webkit].concat(args), { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "sparse fixture");
    const commit = git("rev-parse", "HEAD");
    git("config", "uploadpack.allowfilter", "true");
    const origin = join(options.repository, "private/origin");
    renameSync(webkit, origin);
    execFileSync("git", ["clone", "-q", "--depth=1", "--filter=blob:none", "--no-checkout", `file://${origin}`, webkit]);
    git("sparse-checkout", "set", "Source");
    git("checkout", "-q", "--detach", commit);
    const patch = join(options.repository, "private/webkit-wasi.patch");
    writeFileSync(patch, "diff --git a/Source/patch-probe.h b/Source/patch-probe.h\n--- a/Source/patch-probe.h\n+++ b/Source/patch-probe.h\n@@ -1 +1 @@\n-original\n+patched\n");
    git("apply", "--index", patch);
    git("remote", "set-url", "origin", `file://${origin}-unavailable`);
    const common = join(import.meta.dir, "../jsc/common.sh");
    const verify = () => execFileSync("bash", ["-euo", "pipefail", "-c", 'source "$1"; JSC_SRC="$2"; WEBKIT_COMMIT="$3"; check_jsc_webkit_tree; if git -C "$WEBKIT_DIR" cat-file -e HEAD:LayoutTests/unused.html 2>/dev/null; then exit 94; fi; git -C "$WEBKIT_DIR" ls-files -v', "offline-check", common, join(options.repository, "private"), commit], { encoding: "utf8", env: { ...process.env, JSC_BUILD_DIR: root, JSC_PROFILE: "split", GIT_NO_LAZY_FETCH: "1", TMPDIR: join(options.repository, "private") } });
    const before = verify();
    expect(before).toContain("S LayoutTests/unused.html");
    const archive = join(options.repository, "private/prebuild.tar.zst");
    packJscArtifact({ root, profile: "split", sdk: options.sdk, sysroot: options.sysroot }, archive);
    renameSync(root, join(options.repository, "private/producer"));
    execFileSync("bash", ["-euo", "pipefail", "-c", 'zstd -dc "$1" | tar -C "$2" -xf -', "import", archive, options.repository]);
    expect(verify()).toBe(before);
    expect(git("config", "core.sparseCheckout")).toBe("true");
    expect(readFileSync(join(webkit, ".git/shallow"), "utf8").trim()).toBe(commit);
    expect(readFileSync(join(webkit, "Source/patch-probe.h"), "utf8")).toBe("patched\n");
  });
});

test("compact import keeps persisted WASI compiler metadata usable by the real CMake preflight", async () => {
  await withReceiptFixture(async options => {
    const root = options.jscBuild!;
    seedJscArtifact(root);
    const obj = join(root, "build/jsc");
    mkdirSync(join(options.sdk, "bin"));
    for (const name of ["clang", "clang++"]) symlinkSync(join(options.repository, "fake-tool"), join(options.sdk, "bin", name));
    writeFileSync(join(obj, "CMakeCache.txt"), readFileSync(join(obj, "CMakeCache.txt"), "utf8") + `CMAKE_SYSROOT:PATH=${options.sysroot}\n`);
    for (const [language, name] of [["C", "clang"], ["CXX", "clang++"]]) writeFileSync(join(obj, `CMakeFiles/4.4.5/CMake${language}Compiler.cmake`), `set(CMAKE_${language}_COMPILER "${options.sdk}/bin/${name}")\n`);
    writeFileSync(join(obj, "CMakeFiles/4.4.5/CMakeSystem.cmake"), 'set(CMAKE_SYSTEM_NAME "WASI")\nset(CMAKE_SYSTEM_PROCESSOR "wasm32")\n');
    writeFileSync(join(obj, "CMakeFiles/rules.ninja"), `rule C_COMPILER__fixture\n  command = ${options.sdk}/bin/clang --target=wasm32-wasip1\nrule CXX_COMPILER__fixture\n  command = ${options.sdk}/bin/clang++ --target=wasm32-wasip1\n`);
    const cmake = Bun.which("cmake");
    if (!cmake) throw new Error("Source env.sh to install the CMake preflight tool");
    const preflight = () => execFileSync(cmake, [`-DBUILD_DIR=${obj}`, `-DEXPECTED_C=${options.sdk}/bin/clang`, `-DEXPECTED_CXX=${options.sdk}/bin/clang++`, "-DEXPECTED_SYSTEM=WASI", "-DEXPECTED_PROCESSOR=wasm32", "-DEXPECTED_TARGET=wasm32-wasip1", `-DEXPECTED_SYSROOT=${options.sysroot}`, `-DEXPECTED_TOOLCHAIN_FILE=${root}/inputs/wasi-jsc.cmake`, "-P", join(import.meta.dir, "check-cmake-cache.cmake")]);
    preflight();
    const archive = join(options.repository, "private/prebuild.tar.zst");
    packJscArtifact({ root, profile: "split", sdk: options.sdk, sysroot: options.sysroot }, archive);
    renameSync(root, join(options.repository, "private/producer"));
    execFileSync("bash", ["-euo", "pipefail", "-c", 'zstd -dc "$1" | tar -C "$2" -xf -', "import", archive, options.repository]);
    preflight();
  });
});
