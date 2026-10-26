import { expect, test } from "bun:test";
import { viteApps } from "./app-matrix/product-vite";
import { nextApps } from "./app-matrix/product-next";
import { fixtures, stages } from "../tests/shell-product/fixtures";

test("shell product reuses unchanged original Vite React and Next 15 source and dependencies", () => {
  expect(fixtures.map(fixture => fixture.id)).toEqual(["vite-react", "next-15-app"]);
  for (const fixture of fixtures) {
    const source = viteApps.concat(nextApps).find(app => app.id === fixture.id);
    expect(source).toBeDefined();
    if (!source) throw new Error(`Missing catalog fixture ${fixture.id}`);
    expect(fixture.files).toBe(source.files);
    expect(fixture.dependencies).toBe(source.dependencies);
    expect(fixture.buildOutputs.length).toBeGreaterThan(0);
  }
});

test("both real development commands accept the default and inline PORT override", () => {
  for (const fixture of fixtures) {
    expect(fixture.scripts.dev).toContain("--port ${PORT:-3137}");
    expect(fixture.dependencies[fixture.tool]).toBeDefined();
    expect(fixture.scripts.build).toBe(`${fixture.tool} build`);
  }
});

test("scoreboard includes every required stage and all three stop cycles", () => {
  expect(new Set(stages).size).toBe(stages.length);
  expect(stages.filter(name => /^ctrl-c-\d$/.test(name))).toEqual(["ctrl-c-1", "ctrl-c-2", "ctrl-c-3"]);
  expect(stages).toContain("install-and-dev-dom");
  expect(stages).toContain("build-tail");
  expect(stages).toContain("bun-x-grep");
  expect(stages).toContain("redirect");
  expect(stages).toContain("and-or-status");
  expect(stages).toContain("cwd");
  expect(stages).toContain("port-3001-dom");
});
