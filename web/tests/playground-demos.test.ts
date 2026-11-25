import { expect, test } from "bun:test";
import { examples } from "../src/examples";
import { demo, demos } from "../src/playground/demos";
import { copy } from "../src/playground/showcase-copy";
import { orderFiles } from "../src/playground/editor-pane";
import { visibleLength, wrapWords } from "../src/playground/playground";

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
  expect(demo("nope")).toBeUndefined();
  expect(demo(null)).toBeUndefined();
});

test("the Bun.serve demo listens on a fixed port so its preview and Restart find it", () => {
  expect(examples["serve.ts"]).toContain("port: 3000");
});

test("demo databases are in memory, so two tabs never write one SQLite file", () => {
  for (const name of ["serve.ts", "db.ts"]) {
    expect(examples[name]).toContain('new Database(":memory:")');
    expect(examples[name]).not.toMatch(/new Database\("[^:]/);
  }
});

test("demos that touch files resolve them from their own directory, not the shell's", () => {
  for (const name of ["build.ts", "files.ts", "shell.ts"]) expect(examples[name]).toContain("import.meta.dir");
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
