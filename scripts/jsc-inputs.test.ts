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
    writeFileSync(join(root, "scripts", "build-jsc.sh"), "# fixture build recipe\n");
    writeFileSync(join(root, "jsc", "wasi-jsc.cmake"), "# fixture toolchain\n");
    for (const file of ["wasi-compat.h", "wasi-compat.c", "madvise.c"]) {
      writeFileSync(join(root, "jsc", "shim", file), `// fixture ${file}\n`);
    }
    const shell = (command: string, env: Record<string, string> = {}) => {
      const result = Bun.spawnSync(["bash", "-c", 'source "$1/jsc/common.sh"; copy_jsc_config_inputs; ' + command, "jsc-inputs-test", root], {
        env: { ...process.env, ...env, JSC_BUILD_DIR: join(root, "build") },
      });
      expect(result.exitCode).toBe(0);
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
