import { test, expect } from "bun:test";
import { projectTemplate, projectTemplates } from "../src/playground/project-templates";
import { templateFiles } from "../../sandbox/template-files";
import { templateFiles as parseTemplate } from "../../sandbox/src/template";
import { resolve } from "node:path";

test("the playground retains separate Vite React, Pages and App Router workspaces", () => {
  expect(projectTemplates.map(template => template.id)).toEqual(["vite-react", "next", "next-app"]);
  expect(projectTemplate("vite-react")?.editorFile).toBe("src/App.tsx");
  expect(projectTemplate("next")?.editorFile).toBe("pages/index.tsx");
  expect(projectTemplate("next-app")).toEqual({ id: "next-app", label: "Next.js App Router", directory: "template-next-app", file: "next-app.json", editorFile: "app/page.tsx" });
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

for (const directory of ["template-next", "template-next-app"]) test(`${directory} ships TypeScript and the official WASM compiler without npm bootstrap`, async () => {
  const path = resolve(import.meta.dir, "../../sandbox", directory, "package.json");
  const manifest = await Bun.file(path).json();
  expect(manifest.scripts).toMatchObject({
    build: "next build",
    start: "NEXT_TELEMETRY_DISABLED=1 next start --hostname 127.0.0.1 --port 5173",
  });
  expect(manifest.dependencies["@next/swc-wasm-nodejs"]).toBe(manifest.dependencies.next);
  expect(manifest.devDependencies.typescript).toBeDefined();
  expect(manifest.devDependencies["@types/react"]).toBeDefined();
  expect(manifest.devDependencies["@types/node"]).toBeDefined();
});


test("App Router terminal files contain no Pages route or prebuilt application", async () => {
  const template = projectTemplate("next-app");
  expect(template).toBeDefined();
  if (!template) throw new Error("Missing terminal App Router template");
  const files = await templateFiles(resolve(import.meta.dir, "../../sandbox", template.directory));
  expect(files[template.editorFile]).toStartWith('"use client";');
  expect(files["app/layout.tsx"]).toContain('<html lang="en">');
  expect(files["pages/index.tsx"]).toBeUndefined();
  expect(Object.keys(files).some(path => path.startsWith("node_modules/") || path.startsWith(".next/"))).toBe(false);
});
