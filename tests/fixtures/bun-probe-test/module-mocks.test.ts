// mock.module resolution as native Bun does it (docs/bun-api-probe.md).
import { expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
mkdirSync(join(here, "mods/a"), { recursive: true });
mkdirSync(join(here, "mods/b"), { recursive: true });
mkdirSync(join(here, "node_modules/dual"), { recursive: true });
writeFileSync(join(here, "mods/target.ts"), `export const name = "real";\n`);
for (const name of ["async", "slow", "thenable"]) writeFileSync(join(here, `mods/${name}.ts`), `export const name = "real-${name}";\n`);
writeFileSync(join(here, "mods/b/probe.ts"), `export const load = () => import("./missing.ts").then(m => m.name, () => "unresolved");\n`);
writeFileSync(join(here, "node_modules/dual/package.json"), JSON.stringify({ name: "dual", exports: { import: "./esm.mjs", require: "./cjs.cjs" } }));
writeFileSync(join(here, "node_modules/dual/esm.mjs"), `export const kind = "esm";\n`);
writeFileSync(join(here, "node_modules/dual/cjs.cjs"), `module.exports = { kind: "cjs" };\n`);

test("a second mock replaces the first through every spelling", async () => {
  mock.module("./mods/target", () => ({ name: "first" }));
  expect((await import("./mods/target")).name).toBe("first");
  mock.module("./mods/target.ts", () => ({ name: "second" }));
  expect((await import("./mods/target")).name).toBe("second");
  expect(require("./mods/target").name).toBe("second");
  expect(require.resolve("./mods/target")).toBe(join(here, "mods/target.ts"));
  expect(import.meta.resolveSync("./mods/target")).toBe(join(here, "mods/target.ts"));
});

test("a missing file is mocked relative to the caller only", async () => {
  mock.module("./mods/a/missing.ts", () => ({ name: "mocked-missing" }));
  expect((await import("./mods/a/missing.ts")).name).toBe("mocked-missing");
  expect(await (await import("./mods/b/probe.ts")).load()).toBe("unresolved");
});

test("a builtin mock covers every import spelling but not require", async () => {
  mock.module("node:os", () => ({ hostname: () => "mocked-host" }));
  expect((await import("os")).hostname()).toBe("mocked-host");
  expect((await import("node:os")).hostname()).toBe("mocked-host");
  expect(require("node:os").hostname()).not.toBe("mocked-host");
});

test("a package mock replaces its import entry", async () => {
  mock.module("dual", () => ({ kind: "mocked" }));
  expect((await import("dual")).kind).toBe("mocked");
});

test("an async factory settles before import() sees it", async () => {
  mock.module("./mods/async.ts", async () => ({ name: "async-value" }));
  expect((await import("./mods/async.ts")).name).toBe("async-value");
  mock.module("./mods/slow.ts", async () => {
    await Bun.sleep(20);
    return { name: "slow-value" };
  });
  expect((await import("./mods/slow.ts")).name).toBe("slow-value");
  expect(require("./mods/slow.ts").name).toBe("slow-value");
});

test("a thenable is a value for require() and settles for import()", async () => {
  mock.module("./mods/thenable.ts", () => ({ then(resolve: (value: object) => void) { resolve({ name: "from-then" }); }, name: "own" }));
  expect(require("./mods/thenable.ts").name).toBe("own");
  expect((await import("./mods/thenable.ts")).name).toBe("from-then");
});

test("a missing file is mocked through its file: URL", async () => {
  mock.module("./mods/a/url-missing.ts", () => ({ name: "via-url" }));
  expect((await import(Bun.pathToFileURL(join(here, "mods/a/url-missing.ts")).href)).name).toBe("via-url");
});

test("mock.module argument errors", () => {
  expect(() => (mock.module as unknown as (spec: unknown) => void)(5)).toThrow("mock(module, fn) requires a module name string");
  expect(() => mock.module("./x", undefined as unknown as () => object)).toThrow("mock(module, fn) requires a function");
});
