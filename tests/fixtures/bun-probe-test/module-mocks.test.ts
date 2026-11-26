// mock.module resolution as native Bun does it (docs/bun-api-probe.md).
import { expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
mkdirSync(join(here, "mods/a"), { recursive: true });
mkdirSync(join(here, "mods/b"), { recursive: true });
mkdirSync(join(here, "node_modules/dual"), { recursive: true });
writeFileSync(join(here, "mods/target.ts"), `export const name = "real";\n`);
for (const name of ["async", "slow", "thenable", "defaults", "pending", "linked", "rejects", "importer", "cycle-a", "cycle-b", "late", "shared", "leaf", "dep-a", "dep-b", "late-a", "late-b", "self"]) writeFileSync(join(here, `mods/${name}.ts`), `export const name = "real-${name}";\n`);
writeFileSync(join(here, "mods/b/probe.ts"), `export const load = () => import("./missing.ts").then(m => m.name, () => "unresolved");\n`);
const importer = (target: string) => `import value, { name } from "./${target}.ts";\nimport * as ns from "./${target}.ts";\nexport const seen = [value, name, ns.default].join(" ");\n`;
for (const target of ["defaults", "linked", "rejects"]) writeFileSync(join(here, `mods/uses-${target}.ts`), importer(target));
writeFileSync(join(here, "mods/consumer.ts"), `import { name as a } from "./late-a.ts";\nimport { name as b } from "./late-b.ts";\nexport const seen = [a, b];\n`);
writeFileSync(join(here, "mods/fake.ts"), `export const value = 42;\n`);
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

test("a mock's default key is its default export", async () => {
  mock.module("./mods/defaults.ts", () => ({ default: "mock-default", name: "mock-named" }));
  expect((await import("./mods/uses-defaults.ts")).seen).toBe("mock-default mock-named mock-default");
  expect((await import("./mods/defaults.ts")).default).toBe("mock-default");
});

test("require() of a pending async factory throws until it settles", async () => {
  mock.module("./mods/pending.ts", async () => {
    await Bun.sleep(20);
    return { name: "pending-value" };
  });
  let error: unknown;
  try {
    require("./mods/pending.ts");
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toBe(`require() async module "${join(here, "mods/pending.ts")}" is unsupported. use "await import()" instead.`);
  await Bun.sleep(100);
  expect(require("./mods/pending.ts").name).toBe("pending-value");
});

test("static imports link against a settled async factory", async () => {
  mock.module("./mods/linked.ts", async () => {
    await Bun.sleep(20);
    return { default: "slow-default", name: "slow-mock" };
  });
  expect((await import("./mods/uses-linked.ts")).seen).toBe("slow-default slow-mock slow-default");
});

test("a rejected async factory fails the import that links it", async () => {
  mock.module("./mods/rejects.ts", async () => {
    await Bun.sleep(5);
    throw new Error("factory boom");
  });
  await expect(import("./mods/uses-rejects.ts")).rejects.toThrow("factory boom");
});

test("an async factory's own imports do not wait for it", async () => {
  mock.module("./mods/importer.ts", async () => ({ name: (await import("./mods/fake.ts")).value }));
  expect((await import("./mods/importer.ts")).name).toBe(42);
});

test("async factories that import each other's targets do not deadlock", async () => {
  let bSaw = "";
  mock.module("./mods/cycle-a.ts", async () => ({ name: "a+" + (await import("./mods/cycle-b.ts")).name }));
  mock.module("./mods/cycle-b.ts", async () => {
    const a = await import("./mods/cycle-a.ts");
    bSaw = String(a.name);
    return { name: "b+" + a.name };
  });
  await import("./mods/cycle-a.ts");
  expect(bSaw).toBe("undefined");
  expect((await import("./mods/cycle-b.ts")).name).toBe("b+undefined");
});

test("a factory started by require() can import after awaiting", async () => {
  mock.module("./mods/late.ts", async () => {
    await Bun.sleep(5);
    return { name: (await import("./mods/fake.ts")).value };
  });
  expect(() => require("./mods/late.ts")).toThrow("is unsupported");
  expect((await import("./mods/late.ts")).name).toBe(42);
});

test("concurrent imports of a slow async factory both wait", async () => {
  mock.module("./mods/shared.ts", async () => {
    await Bun.sleep(20);
    return { name: "shared-value" };
  });
  const both = await Promise.all([import("./mods/shared.ts"), import("./mods/shared.ts")]);
  expect(both.map(mod => mod.name)).toEqual(["shared-value", "shared-value"]);
});

test("a factory waiting on another mock's factory is not a cycle", async () => {
  mock.module("./mods/dep-a.ts", async () => ({ name: "a+" + (await import("./mods/leaf.ts")).name }));
  mock.module("./mods/dep-b.ts", async () => ({ name: "b+" + (await import("./mods/dep-a.ts")).name }));
  const both = await Promise.all([import("./mods/dep-a.ts"), import("./mods/dep-b.ts")]);
  expect(both.map(mod => mod.name)).toEqual(["a+real-leaf", "b+a+real-leaf"]);
});

test("async mocks registered while settling are settled before linking", async () => {
  mock.module("./mods/late-a.ts", async () => {
    mock.module("./mods/late-b.ts", async () => {
      await Bun.sleep(5);
      return { name: "mock B" };
    });
    await Bun.sleep(5);
    return { name: "mock A" };
  });
  expect((await import("./mods/consumer.ts")).seen).toEqual(["mock A", "mock B"]);
});

test("a factory that re-registers its own target does not hold up other imports", async () => {
  const factory = async () => {
    mock.module("./mods/self.ts", factory);
    return { name: "self" };
  };
  mock.module("./mods/self.ts", factory);
  expect((await import("./mods/fake.ts")).value).toBe(42);
});

test("mock.module argument errors", () => {
  expect(() => (mock.module as unknown as (spec: unknown) => void)(5)).toThrow("mock(module, fn) requires a module name string");
  expect(() => mock.module("./x", undefined as unknown as () => object)).toThrow("mock(module, fn) requires a function");
});
