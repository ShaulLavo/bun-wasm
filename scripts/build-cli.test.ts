import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

test("both build entrypoints use the production parser matrix without native Bun dependencies", () => {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-build-cli-"));
  try {
    const source = resolve(import.meta.dir, "../crates/bunwasm-build/src/args_tests.rs");
    const binary = join(scratch, "build-args-tests");
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--test", "-D", "warnings", source, "-o", binary], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(compiled.stderr.toString()).toBe("");
    expect(compiled.exitCode).toBe(0);
    const tested = Bun.spawnSync([binary, "--nocapture"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(tested.stderr.toString()).toBe("");
    expect(tested.stdout.toString()).toContain("bun_build_matrix ... ok");
    expect(tested.stdout.toString()).toContain("standalone_matrix ... ok");
    expect(tested.stdout.toString()).toContain("3 passed; 0 failed; 0 ignored");
    expect(tested.exitCode).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 65_000);

test("build startup adapters forward to the shared parser and output runner", () => {
  const entrypoints: readonly [string, string][] = [
    ["crates/bunwasm-build/src/bin/bun-build.rs", "Standalone"],
    ["crates/bunwasm-cli/src/build_command.rs", "Bun"],
  ];
  for (const [path, entrypoint] of entrypoints) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    expect(source).toContain("bunwasm_build::cli::run(");
    expect(source).toContain(`BuildEntrypoint::${entrypoint},`);
    expect(source).not.toContain('"--');
    expect(source).not.toContain("while ");
    expect(source).not.toContain("match ");
  }
});
