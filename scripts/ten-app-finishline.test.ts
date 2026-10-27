import { expect, test } from "bun:test";
import { recipe, targets } from "../tests/ten-app-finishline/recipes.ts";
import { fullstackApps } from "./app-matrix/product-fullstack.ts";

test("finish line retains exactly the owner's ten app families", () => {
  expect(targets).toEqual(["vite-react", "next", "sveltekit", "nuxt", "astro", "react-router", "solidstart", "tanstack-start", "hono", "express"]);
  expect(new Set(targets).size).toBe(10);
  for (const unsupported of ["vitest", "prisma", "koa", "next16", ""]) expect(() => recipe(unsupported)).toThrow();
});
for (const id of ["hono", "express"]) {
  test(`${id} has real development and production sources with a required build`, () => {
    const fixture = recipe(id);
    expect(fixture.dependencies[id]).toBeTruthy();
    expect(fixture.scripts.dev).toBeTruthy();
    expect(fixture.scripts.build).toBeTruthy();
    expect(fixture.scripts.start).toBeTruthy();
    expect(fixture.buildOutputs).toEqual(["dist/production.js"]);
    expect(fixture.files["app.ts"]).toContain(`from '${id}'`);
    expect(fixture.files["app.ts"]).toContain(fixture.text);
    expect(fixture.files["production.ts"]).toContain("import app from './app'");
  });
}
test("SvelteKit uses maintained sources for the full lifecycle", () => {
  const original = fullstackApps.find(app => app.id === "fullstack-sveltekit");
  if (!original) throw new Error("Missing maintained SvelteKit fixture");
  const fixture = recipe("sveltekit");
  expect(fixture.files).toBe(original.files);
  expect(fixture.dependencies).toBe(original.dependencies);
  expect(fixture.scripts).toHaveProperty("dev");
  expect(fixture.scripts.build).toBe("vite build");
  expect(fixture.scripts.start).toBe("bun run start.ts ${PORT:-3137}");
  expect(fixture.editPath).toBe("src/routes/+page.svelte");
  expect(fixture.files[fixture.editPath]).toContain(fixture.text);
  expect(fixture.buildOutputs).toEqual(["build/index.js", "build/handler.js", "build/server/index.js"]);
});
