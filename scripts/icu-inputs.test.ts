import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(run: (root: string, invoke: (env?: NodeJS.ProcessEnv) => { exitCode: number; stdout: Uint8Array }) => void) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-icu-inputs-"));
  // This fixture owns one temporary tree and synchronous children, never downloads
  // or configures real ICU, and installs teardown before invoking the build script.
  try {
    for (const path of ["jsc", "bin", "sdk/bin", "sysroot", "icu"]) mkdirSync(join(root, path), { recursive: true });
    copyFileSync(new URL("../jsc/build-icu.sh", import.meta.url), join(root, "jsc/build-icu.sh"));
    writeFileSync(join(root, "jsc/common.sh"), `set -euo pipefail
JSC_SRC=${JSON.stringify(join(root, "jsc"))}
REPO=${JSON.stringify(root)}
ICU_DIR=${JSON.stringify(join(root, "icu"))}
ICU_PREFIX="$ICU_DIR/prefix"
ICU_VERSION=78.3
ICU_SHA256=fixture
BUN_WASM_SYSROOT=${JSON.stringify(join(root, "sysroot"))}
WASI_SDK_PATH=${JSON.stringify(join(root, "sdk"))}
`);
    writeFileSync(join(root, "sysroot/bun-wasm-sysroot.json"), "fixture sysroot\n");
    writeFileSync(join(root, "sdk/VERSION"), "fixture sdk\n");
    const executable = (path: string, source: string) => writeFileSync(join(root, path), `#!/usr/bin/env bash\n${source}\n`, { mode: 0o755 });
    executable("bin/bun", "exit 0");
    executable("bin/curl", "echo 'fixture refuses downloads' >&2; exit 71");
    for (const tool of ["bin/cc", "bin/c++", "sdk/bin/clang", "sdk/bin/clang++"]) executable(tool, "echo 'fixture compiler version 1'");
    const invoke = (env: NodeJS.ProcessEnv = {}) => Bun.spawnSync(["bash", join(root, "jsc/build-icu.sh")], {
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CC: join(root, "bin/cc"), CXX: join(root, "bin/c++"), CPATH: "", C_INCLUDE_PATH: "", CPLUS_INCLUDE_PATH: "", ...env },
    });
    expect(invoke().exitCode).toBe(71);
    for (const lib of ["icudata", "icuuc", "icui18n"]) {
      mkdirSync(join(root, "icu/prefix/lib"), { recursive: true });
      writeFileSync(join(root, `icu/prefix/lib/lib${lib}.a`), `fixture ${lib}`);
    }
    const original = invoke();
    expect(original.exitCode).toBe(0);
    expect(original.stdout.toString()).toContain("already built");
    run(root, invoke);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("ICU reuse fingerprints compiler commands and include environment without blessing old archives", () => {
  fixture((root, invoke) => {
    const receipt = readFileSync(join(root, "icu/.bunwasm-inputs"), "utf8");
    for (const change of [
      { CXX: "/definitely-missing-compiler" }, { CC: "/definitely-missing-compiler" },
      { CPATH: "/different/include" }, { C_INCLUDE_PATH: "/different/c" },
      { CPLUS_INCLUDE_PATH: "/different/cxx" }, { CPPFLAGS: "-DFIXTURE=1" },
      { CXXFLAGS: "-DFIXTURE=2" }, { LIBRARY_PATH: "/different/lib" },
    ]) {
      const result = invoke(change);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).not.toContain("already built");
      expect(readFileSync(join(root, "icu/.bunwasm-inputs"), "utf8")).toBe(receipt);
      expect(readFileSync(join(root, "icu/prefix/lib/libicuuc.a"), "utf8")).toBe("fixture icuuc");
    }
    // The effective path, not just the compiler's version text, participates.
    copyFileSync(join(root, "bin/c++"), join(root, "bin/alternate-c++"));
    expect(invoke({ CXX: join(root, "bin/alternate-c++") }).exitCode).not.toBe(0);
    expect(invoke().exitCode).toBe(0);
  });
});

test("ICU reuse fails closed when either SDK compiler probe fails", () => {
  fixture((root, invoke) => {
    const receipt = readFileSync(join(root, "icu/.bunwasm-inputs"), "utf8");
    writeFileSync(join(root, "sdk/bin/clang"), "#!/usr/bin/env bash\nexit 72\n", { mode: 0o755 });
    const result = invoke();
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).not.toContain("already built");
    expect(readFileSync(join(root, "icu/.bunwasm-inputs"), "utf8")).toBe(receipt);
  });
});
