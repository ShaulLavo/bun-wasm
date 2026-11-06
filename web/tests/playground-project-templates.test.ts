import { test, expect } from "bun:test";
import { projectTemplate, projectTemplates } from "../src/playground/project-templates";
import { templateFiles } from "../../sandbox/template-files";
import { templateFiles as parseTemplate } from "../../sandbox/src/template";
import { resolve } from "node:path";

test("the playground retains separate Vite React and Next workspaces", () => {
  expect(projectTemplates.map(template => template.id)).toEqual(["vite-react", "next"]);
  expect(projectTemplate("vite-react")?.editorFile).toBe("src/App.tsx");
  expect(projectTemplate("next")?.editorFile).toBe("pages/index.tsx");
  expect(projectTemplate(null)).toBeUndefined();
  expect(projectTemplate("unknown")).toBeUndefined();
});

for (const template of projectTemplates) {
  test(`${template.id} ships a usable project and its initial editor file`, async () => {
    const files = await templateFiles(resolve(import.meta.dir, "../../sandbox", template.directory));
    expect(parseTemplate(JSON.stringify({ files }))).toEqual(files);
    expect(files[template.editorFile]).toBeDefined();
  });
}

test("Next ships TypeScript and the official WASM compiler without npm bootstrap", async () => {
  const path = resolve(import.meta.dir, "../../sandbox/template-next/package.json");
  const manifest = await Bun.file(path).json();
  expect(manifest.dependencies["@next/swc-wasm-nodejs"]).toBe(manifest.dependencies.next);
  expect(manifest.devDependencies.typescript).toBeDefined();
  expect(manifest.devDependencies["@types/react"]).toBeDefined();
  expect(manifest.devDependencies["@types/node"]).toBeDefined();
});
