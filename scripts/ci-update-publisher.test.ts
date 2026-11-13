import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("publisher preflight passes the current status reporter without expected error annotations", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-updater-"));
  try {
    const result = Bun.spawnSync(["bash", ".github/scripts/test-publish-update.sh"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TMPDIR: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(result.exitCode, output).toBe(0);
    expect(output).toContain("Publisher fixtures passed:");
    expect(output).toContain("PASS: required statuses report the real tested results and API errors fail closed");
    expect(output).not.toContain("::error::");
    expect(readdirSync(scratch)).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
