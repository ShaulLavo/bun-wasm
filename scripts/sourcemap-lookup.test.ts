import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("source-map lookup preserves positions without allocating decoded maps", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-sourcemap-"));
  try {
    const source = readFileSync(new URL("../crates/bunwasm-runtime/src/sourcemap.rs", import.meta.url), "utf8");
    const modules = readFileSync(new URL("../crates/bunwasm-runtime/src/modules.rs", import.meta.url), "utf8");
    const start = modules.indexOf("impl PositionMap {");
    const end = modules.indexOf("/// What kind of module", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    writeFileSync(join(scratch, "sourcemap.rs"), source);
    const fixture = readFileSync(new URL("../tests/controls/sourcemap-lookup.rs", import.meta.url), "utf8");
    const input = join(scratch, "control.rs");
    writeFileSync(input, fixture.replace("// PRODUCTION_POSITION_MAP", modules.slice(start, end)));
    for (const mode of ["debug", "release", "allocation"]) {
      const binary = join(scratch, mode);
      const flags = mode === "allocation" ? [] : ["--test"];
      const optimization = mode === "debug" ? [] : ["-O"];
      const entry = mode === "allocation" ? input : join(scratch, "sourcemap.rs");
      const compiled = Bun.spawnSync(["rustc", "--edition=2024", "-D", "warnings"].concat(flags, optimization, [entry, "-o", binary]), {
        stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      expect(compiled.stderr.toString()).toBe("");
      expect(compiled.exitCode).toBe(0);
      const result = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
      console.info(result.stdout.toString());
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    expect(existsSync(scratch)).toBe(false);
  }
}, 120_000);
