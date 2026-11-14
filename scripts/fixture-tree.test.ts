import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageFixtureTree } from "./fixture-tree";
import { oxcFixture } from "./real-oxc-consumer";
import { sharedWasmBrowserPlan } from "../web/tests/shared-wasm-browser-plan";

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

test("SpiderMonkey's Oxc plan runs only entries present in the staged Oxc tree", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-fixture-tree-"));
  try {
    const entries = await stageFixtureTree(oxcFixture, join(scratch, "stage"));
    const files = new Set(entries.filter(entry => entry.kind === "file").map(entry => entry.path));
    const plan = sharedWasmBrowserPlan("spidermonkey", oxcFixture, undefined);
    expect(plan.spiderMonkeyCanaries).toBe(false);
    expect(plan.entries).toEqual(["index.ts", "direct.ts", "async.ts"]);
    for (const entry of plan.entries) expect(files.has(entry)).toBe(true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("default SpiderMonkey qualification retains canaries and every existing entry", () => {
  const plan = sharedWasmBrowserPlan("spidermonkey", undefined, undefined);
  expect(plan.spiderMonkeyCanaries).toBe(true);
  expect(plan.entries).toEqual(["browser-guest.ts", "parser-reserve-ownership.ts", "failed-stop.ts", "address-space/guest.ts"]);
  expect(sharedWasmBrowserPlan("spidermonkey", undefined, "custom.ts")).toEqual({ entries: ["custom.ts"], spiderMonkeyCanaries: true });
  expect(sharedWasmBrowserPlan("jsc", undefined, undefined).spiderMonkeyCanaries).toBe(false);
});
