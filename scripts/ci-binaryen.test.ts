import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryenPin, installBinaryen, verifyBinaryenArchive } from "./ci-binaryen";

for (const contents of ["tampered archive", ""]) {
  test(`Binaryen setup rejects ${contents ? "tampered" : "empty"} cached archives before extraction`, async () => {
    const root = mkdtempSync(join(tmpdir(), "bun-wasm-binaryen-"));
    try {
      const name = `binaryen-${binaryenPin.release}-x86_64-linux.tar.gz`;
      const archive = join(root, name);
      writeFileSync(archive, contents);
      await expect(verifyBinaryenArchive(archive)).rejects.toThrow("checksum mismatch");
      await expect(installBinaryen(root)).rejects.toThrow("checksum mismatch");
      expect(readdirSync(root)).toEqual([name]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("Binaryen setup requires explicit runner-owned paths before doing work", () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "ci-binaryen.ts")], {
    env: { ...process.env, WASM_TOOLS: "", GITHUB_PATH: "" },
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stderr.toString()).toContain("Set WASM_TOOLS and GITHUB_PATH");
});
