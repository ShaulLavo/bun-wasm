import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";

const execute = promisify(execFile);

test("packed package includes a working public worker, no demo or guest binaries", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-package-payload-"));
  const root = resolve(import.meta.dir, "../..");
  try {
    await execute(process.execPath, ["pm", "pack", "--destination", scratch, "--quiet"], { cwd: root, timeout: 20_000 });
    const archive = (await readdir(scratch)).find(name => name.endsWith(".tgz"))!;
    const { stdout: listing } = await execute("tar", ["-tzf", join(scratch, archive)], { timeout: 10_000 });
    const files = listing.trim().split("\n");
    expect(files).toContain("package/web/src/worker-entry.ts");
    expect(files).toContain("package/dist/package/index.js");
    expect(files.some(name => /\.wasm(?:\.gz)?$/.test(name))).toBe(false);
    expect(files).not.toContain("package/web/src/main.ts");
    expect(files).not.toContain("package/web/src/subprocess-broker.ts");
    await execute("tar", ["-xzf", join(scratch, archive), "-C", scratch], { timeout: 10_000 });
    await mkdir(join(scratch, "node_modules"));
    await symlink(join(scratch, "package"), join(scratch, "node_modules/bun-wasm"));
    await symlink(join(root, "node_modules/waffle"), join(scratch, "node_modules/waffle"));
    await copyFile(join(import.meta.dir, "fixtures/vite-main.ts"), join(scratch, "main.ts"));
    await build({ configFile: false, root: scratch, logLevel: "error", worker: { format: "es" },
      build: { outDir: join(scratch, "output"), minify: false, rolldownOptions: { input: join(scratch, "main.ts") } },
    });
    expect((await readdir(join(scratch, "output/assets"))).some(name => name.startsWith("worker-entry-") && name.endsWith(".js"))).toBe(true);
    const index = await readFile(join(scratch, "package/dist/package/index.js"), "utf8");
    expect(index).not.toContain("waffle.runtime.owner");
    const { stdout } = await execute("node", ["--input-type=module", "-e", `
      const p = await import('bun-wasm');
      const asset = await import('bun-wasm/asset');
      if (typeof p.installBunAdapters !== 'function') process.exit(1);
      try { await asset.loadBunWasm({ asset: { url: 'https://example.test', sha256: 'invalid', bytes: 8 } }); }
      catch (error) { if (!(error instanceof p.BunWasmAssetError)) process.exit(2); }
      console.log('ok');
    `], { cwd: scratch, timeout: 10_000 });
    expect(stdout.trim()).toBe("ok");
    const { stdout: bunPaths } = await execute(process.execPath, ["--eval", "console.log(import.meta.resolve('bun-wasm')); console.log(import.meta.resolve('bun-wasm/asset'))"], { cwd: scratch, timeout: 10_000 });
    expect(bunPaths).toContain("/web/src/index.ts");
    expect(bunPaths).toContain("/web/src/assets.ts");
    expect(bunPaths).not.toContain("/dist/");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 45_000);
