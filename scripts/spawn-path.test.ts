import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { load, service } from "./spawn-runtime-proc-fixture";

function fixture(entries: Readonly<Record<string, number>>) {
  const fake = service();
  const queries: Array<[string, string]> = [];
  fake.native.procAccess = (path: string, cwd: string) => { queries.push([path, cwd]); return entries[path] ?? -44; };
  const state = load(fake);
  return { ...state, fake, queries };
}

test("Bun.which and spawn select the same first executable in PATH", () => {
  const f = fixture({ "/opt/bun/quickjs/bin/bun": 0, "/bin/bun": 0 });
  const PATH = "/opt/bun/quickjs/bin:/bin";
  expect(f.module.which("bun", { PATH })).toBe("/opt/bun/quickjs/bin/bun");
  f.module.spawn(["bun", "-e", "0"], { env: { PATH } });
  const child = Array.from(f.fake.children.values())[0]!;
  expect(child.request.executable).toBe(f.module.which("bun", { PATH }));
  expect(child.request.env).toEqual({ PATH });
  f.fake.exit(child, 0);
});

test("PATH lookup skips earlier non-executable and non-directory matches", () => {
  const f = fixture({ "/blocked/bun": -2, "/not-a-directory/bun": -54, "/bin/bun": 0 });
  const PATH = "/blocked:/not-a-directory:/bin";
  expect(f.module.which("bun", { PATH })).toBe("/bin/bun");
  expect(f.queries.map(query => query[0])).toEqual(["/blocked/bun", "/not-a-directory/bun", "/bin/bun"]);
  f.module.spawn(["bun"], { env: { PATH } });
  const child = Array.from(f.fake.children.values())[0]!;
  expect(child.request.executable).toBe("/bin/bun");
  f.fake.exit(child, 0);
});

test("missing commands preserve ENOENT while denied PATH matches preserve EACCES", () => {
  for (const [entries, code] of [[{}, "ENOENT"], [{ "/blocked/bun": -2 }, "EACCES"]] as const) {
    const f = fixture(entries);
    expect(f.module.which("bun", { PATH: "/blocked:/missing" })).toBeNull();
    try { f.module.spawn(["bun"], { env: { PATH: "/blocked:/missing" } }); throw new Error("spawn succeeded"); }
    catch (error) { expect(error).toMatchObject({ code, path: "bun" }); }
    expect(f.fake.children.size).toBe(0);
    expect(f.fake.open()).toBe(0);
  }
});

test("empty PATH entries mean cwd and explicit paths bypass PATH", () => {
  const f = fixture({ "/work/bun": 0, "/bin/bun": 0, "./bun": 0, "/not-directory/bun": -54 });
  expect(f.module.which("bun", { PATH: ":/bin" })).toBe("/work/bun");
  expect(f.module.which("./bun", { PATH: "/missing" })).toBe("/work/bun");
  f.queries.length = 0;
  f.module.spawn(["/bin/bun"], { env: { PATH: "/missing" } });
  expect(f.queries).toEqual([["/bin/bun", "/work"]]);
  const child = Array.from(f.fake.children.values())[0]!;
  expect(child.request.executable).toBe("/bin/bun");
  f.fake.exit(child, 0);
  expect(() => f.module.spawn(["/not-directory/bun"])).toThrow("ENOTDIR");
  expect(f.module.which("")).toBeNull();
});

test("package command normalization precedes the shared PATH lookup", () => {
  const fake = service();
  const seen: unknown[] = [];
  const f = load(fake, { spawnArguments(argv, cwd) { seen.push([argv, cwd]); return ["bun", "x"].concat(argv.slice(1)); } });
  f.module.spawn(["bunx", "package-name"], { cwd: "/tmp" });
  const child = Array.from(fake.children.values())[0]!;
  expect(seen).toEqual([[["bunx", "package-name"], "/tmp"]]);
  expect(child.request.argv).toEqual(["bun", "x", "package-name"]);
  expect(child.request.executable).toBe("/bin/bun");
  fake.exit(child, 0);
});

for (const executable of ["bunx", "/bunx"]) test(`real package normalization expands ${executable} before executable admission`, () => {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/package_scripts.ts", import.meta.url), "utf8");
  const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.packageFactory = ${source}`));
  const packages = factory({ native: {}, require() { return {}; } });
  const fake = service();
  const { module: api } = load(fake, { spawnArguments: packages.spawnArguments });
  api.spawn([executable, "package-name", "argument"]);
  const child = Array.from(fake.children.values())[0]!;
  expect(child.request.argv).toEqual(["bun", "x", "package-name", "argument"]);
  expect(child.request.executable).toBe("/bin/bun");
  fake.exit(child, 0);
});
