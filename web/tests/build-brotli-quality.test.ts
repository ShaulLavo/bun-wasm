import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

// Each build removes its previous dist first, so a bad setting must fail before that.
test.each(["web", "sandbox"])("the %s build refuses an invalid Brotli quality before touching its previous output", async app => {
  const dist = join(root, app, "dist");
  const created = !existsSync(dist);
  const marker = join(dist, `.brotli-quality-probe-${randomUUID()}`);
  await mkdir(dist, { recursive: true });
  await writeFile(marker, "previous build");
  try {
    const child = Bun.spawn([process.execPath, join(root, app, "build.ts")], {
      cwd: join(root, app), env: { ...process.env, BUN_WASM_BROTLI_QUALITY: "12" }, stdout: "pipe", stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      expect(await child.exited).not.toBe(0);
      expect(await new Response(child.stderr).text()).toContain("BUN_WASM_BROTLI_QUALITY must be an integer from 0 to 11");
    } finally { clearTimeout(timeout); }
    expect(existsSync(marker)).toBe(true);
  } finally {
    await rm(marker, { force: true });
    if (created) await rmdir(dist).catch(() => {});
  }
}, 40_000);
