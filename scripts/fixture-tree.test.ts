import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFixtureTree } from "./fixture-tree";

async function fixtureTree(check: (source: string, destination: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-fixture-tree-"));
  try {
    const source = join(scratch, "source");
    await mkdir(join(source, "node_modules/@oxc-parser/binding-wasm32-wasi/empty"), { recursive: true });
    await writeFile(join(source, "index.ts"), "import 'oxc-parser';\n");
    await writeFile(join(source, "bun.lock"), "frozen lock bytes\n");
    await writeFile(join(source, "index.json"), '{"not":"the staging manifest"}\n');
    await writeFile(join(source, "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm"), new Uint8Array([0, 97, 115, 109, 255]));
    await writeFile(join(source, "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasi.cjs"), "synthetic loader bytes\n");
    await check(source, join(scratch, "stage"));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

test("staging includes nested scoped packages, loader bytes, the frozen lock and empty directories", async () => {
  await fixtureTree(async (source, destination) => {
    const entries = await stageFixtureTree(source, destination);
    expect(entries).toContainEqual({ kind: "file", path: "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm" });
    expect(entries).toContainEqual({ kind: "file", path: "bun.lock" });
    expect(entries).toContainEqual({ kind: "directory", path: "node_modules/@oxc-parser/binding-wasm32-wasi/empty" });
    for (const path of ["index.ts", "bun.lock", "index.json", "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm", "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasi.cjs"]) {
      expect(await readFile(join(destination, path))).toEqual(await readFile(join(source, path)));
    }
  });
});

test.each(["@oxc-parser/binding-wasm32-wasi", "../../outside"])("staging refuses unsupported symlinks instead of silently changing the tree: %s", async target => {
  await fixtureTree(async (source, destination) => {
    await symlink(target, join(source, "node_modules/binding"));
    await expect(stageFixtureTree(source, destination)).rejects.toThrow("Unsupported fixture symlink");
  });
});
