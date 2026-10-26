import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as sourcePackage from "../../src/index";

const execute = promisify(execFile);
test("packed source includes private shared-object imports without enabling a public service", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-shared-payload-"));
  const root = resolve(import.meta.dir, "../..");
  try {
    await execute(process.execPath, ["pm", "pack", "--ignore-scripts", "--destination", scratch, "--quiet"], { cwd: root, timeout: 20_000 });
    const archive = (await readdir(scratch)).find(name => name.endsWith(".tgz"));
    if (!archive) throw new Error("Missing packed source archive");
    const { stdout } = await execute("tar", ["-tzf", join(scratch, archive)], { timeout: 10_000 });
    const files = new Set(stdout.trim().split("\n"));
    for (const name of ["broker", "host", "protocol", "runtime", "service"]) expect(files.has(`package/web/src/shared-objects/${name}.ts`)).toBe(true);
    await execute("tar", ["-xzf", join(scratch, archive), "-C", scratch], { timeout: 10_000 });
    await mkdir(join(scratch, "node_modules"));
    await symlink(join(root, "node_modules/waffle"), join(scratch, "node_modules/waffle"));
    const packed = await import(pathToFileURL(join(scratch, "package/src/index.ts")).href);
    expect(Object.keys(packed).sort()).toEqual(Object.keys(sourcePackage).sort());
    expect(packed.installBunAdapters).toBeFunction();
    expect("installRuntimeSharedObjects" in packed).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 40_000);
