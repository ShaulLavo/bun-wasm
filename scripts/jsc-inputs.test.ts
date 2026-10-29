import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(run: (root: string, shell: (command: string, env?: Record<string, string>) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-jsc-inputs-"));
  try {
    mkdirSync(join(root, "jsc", "shim"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    copyFileSync(new URL("../jsc/common.sh", import.meta.url), join(root, "jsc", "common.sh"));
    copyFileSync(new URL("../env.sh", import.meta.url), join(root, "env.sh"));
    copyFileSync(new URL("./check-wasi-cmake-cache.sh", import.meta.url), join(root, "scripts/check-wasi-cmake-cache.sh"));
    writeFileSync(join(root, "scripts", "build-jsc.sh"), "# fixture build recipe\n");
    writeFileSync(join(root, "jsc", "wasi-jsc.cmake"), "# fixture toolchain\n");
    for (const file of ["wasi-compat.h", "wasi-compat.c", "madvise.c"]) {
      writeFileSync(join(root, "jsc", "shim", file), `// fixture ${file}\n`);
    }
    // Input-stamp tests need identities, not a real SDK or workstation tools.
    const sdk = join(root, "sdk"), sysroot = join(root, "sysroot"), bin = join(root, "bin");
    for (const path of [join(sdk, "bin"), sysroot, bin]) mkdirSync(path, { recursive: true });
    writeFileSync(join(sdk, "VERSION"), "34.0\n");
    writeFileSync(join(sysroot, "bun-wasm-sysroot.json"), '{"fixture":"patched sysroot"}\n');
    for (const tool of [join(sdk, "bin/clang"), join(sdk, "bin/clang++"), join(bin, "cmake"), join(bin, "ninja"), join(bin, "wasm-opt")]) {
      writeFileSync(tool, "#!/usr/bin/env bash\nif [[ \"$*\" == *-P* && \"${FIXTURE_BAD_CMAKE:-}\" == true ]]; then exit 42; fi\necho 'fixture tool version 1'\n", { mode: 0o755 });
    }
    const shell = (command: string, env: Record<string, string> = {}) => {
      const result = Bun.spawnSync(["bash", "-c", 'source "$1/jsc/common.sh"; copy_jsc_config_inputs; ' + command, "jsc-inputs-test", root], {
        env: { ...process.env, ...env, JSC_BUILD_DIR: join(root, "build"), WASM_TOOLS: join(root, "tools"), WASI_SDK_PATH: sdk, BUN_WASM_SYSROOT: sysroot, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).toBe("");
      return result.stdout.toString().trim();
    };
    run(root, shell);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("JSC stamp ignores scratch policy but fingerprints effective compiler inputs", () => {
  fixture((root, shell) => {
    const original = shell("jsc_inputs_hash");
    writeFileSync(join(root, "env.sh"), readFileSync(join(root, "env.sh"), "utf8") + '\n# Unrelated workstation policy\nexport TMPDIR=/different/scratch\n');
    expect(shell("jsc_inputs_hash")).toBe(original);
    expect(shell("jsc_inputs_hash", { CFLAGS: "-DJSC_STAMP_REGRESSION=1" })).not.toBe(original);
    writeFileSync(join(root, "jsc", "shim", "wasi-compat.h"), "// changed injected header\n");
    expect(shell("jsc_inputs_hash")).not.toBe(original);
  });
});

test("JSC config refresh preserves identical input timestamps and copies changed bytes", () => {
  fixture((root, shell) => {
    shell(":");
    const header = join(root, "build", "inputs", "shim", "wasi-compat.h");
    const toolchain = join(root, "build", "inputs", "wasi-jsc.cmake");
    const timestamp = new Date("2000-01-01T00:00:00Z");
    utimesSync(header, timestamp, timestamp);
    utimesSync(toolchain, timestamp, timestamp);
    shell(":");
    expect(statSync(header).mtimeMs).toBe(timestamp.getTime());
    expect(statSync(toolchain).mtimeMs).toBe(timestamp.getTime());
    writeFileSync(join(root, "jsc", "shim", "wasi-compat.h"), "// changed injected header\n");
    shell(":");
    expect(readFileSync(header, "utf8")).toBe("// changed injected header\n");
    expect(statSync(header).mtimeMs).not.toBe(timestamp.getTime());
    expect(statSync(toolchain).mtimeMs).toBe(timestamp.getTime());
  });
});


test("warm JSC stamp rejects partial archives, dirty sources, changed SDK and stale CMake", () => {
  fixture((root, shell) => {
    const webkit = join(root, "build/webkit");
    mkdirSync(webkit, { recursive: true });
    writeFileSync(join(webkit, "tracked.cpp"), "original source\n");
    mkdirSync(join(webkit, "outside-sparse"));
    writeFileSync(join(webkit, "outside-sparse/unused.cpp"), "excluded source\n");
    const setup = `git -C "$WEBKIT_DIR" init -q; git -C "$WEBKIT_DIR" add .; git -C "$WEBKIT_DIR" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture;
git -C "$WEBKIT_DIR" sparse-checkout init --cone
git -C "$WEBKIT_DIR" sparse-checkout set Source
printf 'patched source\\n' > "$WEBKIT_DIR/tracked.cpp"
git -C "$WEBKIT_DIR" diff > "$JSC_SRC/webkit-wasi.patch"
for file in "\${JSC_ARTIFACTS[@]}"; do mkdir -p "$(dirname "$file")"; printf 'built archive\\n' > "$file"; done`;
    shell(setup);
    const pin = 'WEBKIT_COMMIT=$(git -C "$WEBKIT_DIR" rev-parse HEAD); ';
    shell(pin + "write_jsc_inputs_stamp; check_jsc_inputs_stamp");
    const reject = (command: string, env?: Record<string, string>) => shell(pin + command + "; if check_jsc_inputs_stamp >/dev/null 2>&1; then exit 91; fi", env);
    reject('rm "$JSC_OBJ/lib/libWTF.a"');
    shell(pin + 'printf "built archive\\n" > "$JSC_OBJ/lib/libWTF.a"; check_jsc_inputs_stamp');
    reject('printf "corrupt archive\\n" > "$JSC_OBJ/lib/libWTF.a"');
    shell(pin + 'printf "built archive\\n" > "$JSC_OBJ/lib/libWTF.a"; check_jsc_inputs_stamp');
    reject('echo changed >> "$WEBKIT_DIR/tracked.cpp"');
    shell(pin + 'if write_jsc_inputs_stamp >/dev/null 2>&1; then exit 93; fi');
    shell(pin + 'git -C "$WEBKIT_DIR" checkout -- tracked.cpp; git -C "$WEBKIT_DIR" apply "$JSC_SRC/webkit-wasi.patch"; check_jsc_inputs_stamp');
    reject('echo untracked > "$WEBKIT_DIR/untracked.cpp"');
    shell(pin + 'rm "$WEBKIT_DIR/untracked.cpp"; check_jsc_inputs_stamp');
    reject(':', { FIXTURE_BAD_CMAKE: "true" });
    reject('rm "$JSC_OBJ/compile_commands.json"');
    shell(pin + 'printf "built archive\\n" > "$JSC_OBJ/compile_commands.json"; check_jsc_inputs_stamp');
    reject('echo changed >> "$JSC_OBJ/cmakeconfig.h"');
    shell(pin + 'printf "built archive\\n" > "$JSC_OBJ/cmakeconfig.h"; check_jsc_inputs_stamp');
    reject('echo changed >> "$WASI_SDK_PATH/VERSION"');
  });
});

test("JSC cache fingerprint rejects failed host compiler probes", () => {
  fixture((_root, shell) => {
    shell('if jsc_inputs_hash >/dev/null 2>&1; then exit 92; fi', { CC: "false" });
  });
});

test("cold JSC fetch stages patch-added files for strict source stamping", () => {
  fixture((root, shell) => {
    const webkit = join(root, "build/webkit");
    mkdirSync(join(webkit, "Source"), { recursive: true });
    writeFileSync(join(webkit, "Source/tracked.cpp"), "original source\n");
    shell('git -C "$WEBKIT_DIR" init -q; git -C "$WEBKIT_DIR" add .; git -C "$WEBKIT_DIR" -c user.name=fixture -c user.email=fixture@example.invalid commit -qm fixture; git -C "$WEBKIT_DIR" sparse-checkout set Source');
    writeFileSync(join(root, "jsc/webkit-wasi.patch"), "diff --git a/Source/added.h b/Source/added.h\nnew file mode 100644\n--- /dev/null\n+++ b/Source/added.h\n@@ -0,0 +1 @@\n+patched header\n");
    copyFileSync(new URL("../jsc/fetch-webkit.sh", import.meta.url), join(root, "jsc/fetch-webkit.sh"));
    const common = join(root, "jsc/common.sh");
    writeFileSync(common, readFileSync(common, "utf8") + '\nWEBKIT_COMMIT=$(git -C "$WEBKIT_DIR" rev-parse HEAD)\n');
    shell('bash "$JSC_SRC/fetch-webkit.sh"; check_jsc_webkit_tree');
    expect(shell('git -C "$WEBKIT_DIR" ls-files --others --exclude-standard')).toBe("");
    expect(shell('git -C "$WEBKIT_DIR" show :Source/added.h')).toBe("patched header");
    shell('bash "$JSC_SRC/fetch-webkit.sh"; check_jsc_webkit_tree');
    const reject = (command: string) => shell(command + '; if check_jsc_webkit_tree >/dev/null 2>&1; then exit 91; fi');
    reject('echo changed >> "$WEBKIT_DIR/Source/added.h"');
    shell('printf "patched header\\n" > "$WEBKIT_DIR/Source/added.h"');
    reject('echo unexpected > "$WEBKIT_DIR/Source/unexpected.h"');
    shell('rm "$WEBKIT_DIR/Source/unexpected.h"');
    reject('rm "$WEBKIT_DIR/Source/added.h"');
  });
});
