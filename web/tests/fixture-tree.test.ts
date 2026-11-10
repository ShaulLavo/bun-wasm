import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureFileUrl, installFixtureTree, parseFixtureTree } from "./fixture-tree";

const entries = [
  { kind: "directory", path: "node_modules" },
  { kind: "directory", path: "node_modules/@oxc-parser" },
  { kind: "directory", path: "node_modules/@oxc-parser/binding-wasm32-wasi" },
  { kind: "file", path: "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm" },
  { kind: "file", path: "bun.lock" },
];

test("the page installer recreates directories and binary payloads from the serialized inventory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-fixture-hydration-"));
  try {
    const tree = parseFixtureTree(JSON.parse(JSON.stringify(entries)));
    const payload = new Uint8Array([0, 97, 115, 109, 255]);
    await installFixtureTree({ mkdirp: path => mkdir(path, { recursive: true }), writeFile }, scratch, tree, async () => payload);
    expect(await readFile(join(scratch, "node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm"))).toEqual(Buffer.from(payload));
    expect(await readFile(join(scratch, "bun.lock"))).toEqual(Buffer.from(payload));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const path of ["../escape", "/absolute", "node_modules/../escape", "bad\\path", "bad\0path", "./relative", "empty//part"]) {
  test(`the page rejects an unsafe fixture path ${JSON.stringify(path)}`, () => {
    expect(() => parseFixtureTree([{ kind: "file", path }])).toThrow("Invalid fixture tree entry");
  });
}

test("the page refuses duplicate paths, missing parents and symlinks instead of changing a tree", () => {
  expect(() => parseFixtureTree([{ kind: "file", path: "node_modules/loader.cjs" }])).toThrow("missing fixture parent");
  expect(() => parseFixtureTree([{ kind: "file", path: "index.ts" }, { kind: "file", path: "index.ts" }])).toThrow("Duplicate");
  expect(() => parseFixtureTree([{ kind: "symlink", path: "binding", target: "elsewhere" }])).toThrow("Invalid fixture kind");
  expect(() => parseFixtureTree("index.ts")).toThrow("Invalid fixture tree inventory");
});

test("fixture URLs preserve scoped packages and reserved characters", () => {
  expect(fixtureFileUrl("node_modules/@scope/pkg/a #?%.cjs")).toBe("./fixture/node_modules/%40scope/pkg/a%20%23%3F%25.cjs");
});
