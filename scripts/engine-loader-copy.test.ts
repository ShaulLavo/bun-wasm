import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("build-qualified streaming engines reuse one source snapshot for declarations and verified cache storage", () => {
  const result = spawnSync(process.execPath, [new URL("../web/tests/fixtures/engine-loader-copy-probe.ts", import.meta.url).pathname], { encoding: "utf8", timeout: 3000 });
  expect({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain("PASS one owned engine source snapshot");
});

function relocateImports(source: string, path: string): string {
  return source.replace(/from "(\.{1,2}\/[^"]+)"/g, (_match, relative: string) => `from ${JSON.stringify(resolve(dirname(path), relative))}`);
}

for (const expression of ["Uint8Array.from(bytes)", "new Uint8Array(bytes)", "bytes.slice()"]) {
  test(`copy probe rejects a redundant snapshot from ${expression}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-engine-copy-"));
    try {
      const loader = new URL("../web/src/engine-loader.ts", import.meta.url).pathname;
      const fixture = new URL("../web/tests/fixtures/engine-loader-copy-probe.ts", import.meta.url).pathname;
      const original = readFileSync(loader, "utf8");
      const mutated = original.replace("  chunks.length = 0;", `  bytes.set(${expression});\n  chunks.length = 0;`);
      expect(mutated).not.toBe(original);
      const mutantPath = join(scratch, "loader.ts");
      const probePath = join(scratch, "probe.ts");
      writeFileSync(mutantPath, relocateImports(mutated, loader));
      writeFileSync(probePath, relocateImports(readFileSync(fixture, "utf8"), fixture).replace(JSON.stringify(loader), JSON.stringify(mutantPath)));
      const result = spawnSync(process.execPath, [probePath], { encoding: "utf8", timeout: 3000 });
      expect({ status: result.status, signal: result.signal }).toEqual({ status: 1, signal: null });
      expect(result.stderr).toContain("loader must allocate exactly one whole-source typed array");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
