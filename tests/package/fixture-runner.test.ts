import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const runner = resolve(import.meta.dir, "../../scripts/test.sh");

test("native expectation updates resolve Bun before resetting HOME and preserve failed expectations", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-fixture-runner-"));
  try {
    const scripts = join(scratch, "scripts");
    const bin = join(scratch, "bin");
    mkdirSync(scripts);
    mkdirSync(bin);
    copyFileSync(runner, join(scripts, "test.sh"));
    writeFileSync(join(scripts, "check-runtime.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(scratch, "env.sh"), 'export CARGO_TARGET_DIR="$TMPDIR/target"\n');
    writeFileSync(join(bin, "bun"), `#!/bin/sh\n[ "$HOME" != / ] || exit 77\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
    const fixture = join(scratch, "tests/fixtures/update");
    mkdirSync(fixture, { recursive: true });
    const expected = join(fixture, "expected.txt");
    const entry = join(fixture, "index.ts");
    const run = () => Bun.spawnSync(["bash", join(scripts, "test.sh"), "--no-build", "--update", "update"], {
      env: { ...process.env, HOME: scratch, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, TMPDIR: scratch },
      stdout: "pipe", stderr: "pipe",
    });
    writeFileSync(expected, "old expectation\n");
    writeFileSync(entry, 'console.log("fixture output");\n');
    expect(run().exitCode).toBe(0);
    expect(readFileSync(expected, "utf8")).toBe("fixture output\n");
    writeFileSync(entry, 'console.log("partial output"); process.exit(9);\n');
    const failed = run();
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.toString()).toContain("native Bun failed update (exit 9, expected 0)");
    expect(readFileSync(expected, "utf8")).toBe("fixture output\n");
    writeFileSync(join(fixture, "manual"), "");
    expect(run().exitCode).toBe(0);
    expect(readFileSync(expected, "utf8")).toBe("fixture output\n");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
