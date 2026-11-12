import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the guest bootstrap reporter retains error properties and returns 70 before entry", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-bootstrap-error-"));
  try {
    const source = readFileSync(new URL("../crates/bunwasm-engine-quickjs/src/program.rs", import.meta.url), "utf8");
    const start = source.indexOf("fn bootstrap_error_text");
    const end = source.indexOf("/// The event loop:", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const input = join(scratch, "control.rs");
    const binary = join(scratch, "control");
    const fixture = readFileSync(new URL("../tests/controls/bootstrap-error.rs", import.meta.url), "utf8");
    writeFileSync(input, fixture.replace("// PRODUCTION_BOOTSTRAP_REPORTER", source.slice(start, end)));
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "-D", "warnings", input, "-o", binary], {
      stdout: "pipe", stderr: "pipe", timeout: 30_000,
    });
    expect(compiled.stderr.toString()).toBe("");
    expect(compiled.exitCode).toBe(0);
    const cases: readonly [string, string][] = [
      ["jsc", "TypeError: original bootstrap failure\nbootstrap@bun-wasm:bootstrap:42:7"],
      ["quickjs", "TypeError: original bootstrap failure\n    at bootstrap (bun-wasm:bootstrap:42:7)"],
      ["no-stack", "TypeError: original bootstrap failure"],
      ["throwing-stack", "TypeError: original bootstrap failure"],
      ["throwing-message", "TypeError: \nbootstrap@bun-wasm:bootstrap:42:7"],
      ["string", 'Str("original string failure")'],
      ["object", "Object([])"],
      ["null", "Null"],
    ];
    for (const [scenario, expected] of cases) {
      const result = Bun.spawnSync([binary, scenario], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      expect(result.stdout.toString()).toBe("original exception retained; entry not reached\n");
      expect(result.stderr.toString()).toBe(`bun-wasm: bootstrap failed: ${expected}\n`);
      expect(result.exitCode).toBe(70);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 65_000);
