import { expect, test } from "bun:test";
import { examples } from "../src/examples";
import { demo, demos } from "../src/playground/demos";
import { copy } from "../src/playground/showcase-copy";
import { orderFiles } from "../src/playground/editor-pane";
import { launchCommand, visibleLength, wrapWords } from "../src/playground/playground";

test("every demo runs a seeded example and restores only seeded files", () => {
  expect(demos.map(entry => entry.id)).toEqual(Object.keys(copy.demos) as typeof demos[number]["id"][]);
  for (const entry of demos) {
    expect(entry.files[0]).toBe(entry.file);
    for (const file of entry.files) expect(Object.keys(examples)).toContain(file);
  }
});

test("demo ids from the address resolve, unknown ones do not", () => {
  expect(demo("serve")?.file).toBe("serve.ts");
  expect(demo("test")?.files).toEqual(["math.test.ts", "math.ts"]);
  expect(demo("check")?.file).toBe("src/check.ts");
  expect(demo("check")?.files).toEqual(["src/check.ts", "tsconfig.json"]);
  expect(demo("check")?.command).toBe("bun check");
  expect(demo("nope")).toBeUndefined();
  expect(demo(null)).toBeUndefined();
});

test("the bun check demo isolates its tsconfig to src/ and has a type error on line 1", () => {
  const tsconfig = JSON.parse(examples["tsconfig.json"]!) as { compilerOptions: Record<string, unknown>; include: string[] };
  expect(tsconfig).toEqual({
    compilerOptions: { strict: true, lib: ["es2022"], noEmit: true },
    include: ["src"],
  });
  expect(examples["src/check.ts"]?.split("\n")[0]).toBe('export const total: number = "three";');
});

test("launchCommand runs bun check for the check demo and its files in the examples workspace", () => {
  const check = demo("check")!;
  expect(launchCommand({ path: "/home/user/src/check.ts", argument: "src/check.ts", demo: check })).toBe("bun check");
  expect(launchCommand({ path: "/home/user/src/check.ts", argument: "/home/user/src/check.ts" }, true)).toBe("bun check --cwd /home/user");
  expect(launchCommand({ path: "/home/user/tsconfig.json", argument: "/home/user/tsconfig.json" }, true)).toBe("bun check --cwd /home/user");
  expect(launchCommand({ path: "/home/user/src/check.ts", argument: "/home/user/src/check.ts" }, false)).toBe("bun run /home/user/src/check.ts");
  expect(launchCommand({ path: "/home/user/math.test.ts", argument: "math.test.ts", demo: demo("test") })).toBe("bun test math.test.ts");
  expect(launchCommand({ path: "/home/user/serve.ts", argument: "serve.ts", demo: demo("serve") })).toBe("bun run serve.ts");
});

test("the Bun.serve demo listens on a fixed port so its preview and Restart find it", () => {
  expect(examples["serve.ts"]).toContain("port: 3000");
});

test("demos whose code changed have new names, so an old workspace's copies are never reused", () => {
  // Main's db.ts opened a shared todos.sqlite and its files.ts wrote relative to the shell's
  // directory. Their replacements must not reuse those names, or exclusive create would keep
  // the old copies and run them.
  expect(demo("sqlite")?.file).toBe("sqlite.ts");
  expect(demo("file")?.file).toBe("bun-file.ts");
  for (const entry of demos) for (const file of entry.files) expect(["db.ts", "files.ts"]).not.toContain(file);
});

test("demo databases are in memory, so two tabs never write one SQLite file", () => {
  for (const name of ["serve.ts", "sqlite.ts"]) {
    expect(examples[name]).toContain('new Database(":memory:")');
    expect(examples[name]).not.toMatch(/new Database\("[^:]/);
  }
});

test("demos that touch files resolve them from their own directory, not the shell's", () => {
  for (const name of ["build.ts", "bun-file.ts", "shell.ts"]) expect(examples[name]).toContain("import.meta.dir");
});

test("tabs put the demo first, generated output last and leave binary files out", () => {
  const home = "/home/user";
  const files = ["dist/math.js", "zeta.ts", "build.ts", "visits.sqlite", "alpha.ts", "dist/jsx.js"].map(name => `${home}/${name}`);
  expect(orderFiles(files, `${home}/zeta.ts`, `${home}/alpha.ts`).map(path => path.slice(home.length + 1)))
    .toEqual(["zeta.ts", "alpha.ts", "build.ts", "dist/jsx.js", "dist/math.js"]);
  expect(orderFiles(files, undefined, `${home}/visits.sqlite`)).toContain(`${home}/visits.sqlite`);
});

test("the welcome banner wraps at words and ignores colour codes", () => {
  const lines = wrapWords("Try \x1b[32mbun repl\x1b[0m, or press Run to start the open file now", 20);
  expect(lines.every(line => visibleLength(line) <= 20)).toBe(true);
  expect(visibleLength("a\x1b[32mbc\x1b[0m")).toBe(3);
  expect(lines.join(" ")).toBe("Try \x1b[32mbun repl\x1b[0m, or press Run to start the open file now");
});
