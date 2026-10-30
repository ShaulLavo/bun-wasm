import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultTemplate, selectTemplate, templates } from "../../sandbox/src/template-catalog";
import { templateFiles } from "../../sandbox/src/template";

const packageJson = JSON.stringify({ scripts: { dev: "framework dev", build: "framework build" } });

test("template selection uses the same catalog as the dropdown and build", () => {
  expect(selectTemplate(null)).toBe(defaultTemplate);
  expect(selectTemplate("unknown")).toBe(defaultTemplate);
  for (const template of templates) expect(selectTemplate(template.id)).toBe(template);
  expect(templates.map(template => template.id)).toEqual(["react", "vanilla"]);
  expect(templates.map(template => template.label)).not.toContain("Vite");
});

test("project files support real framework layouts without a synthetic index.html", () => {
  const files = { "package.json": packageJson, "src/routes/+page.svelte": "<h1>Real route</h1>" };
  expect(templateFiles(JSON.stringify({ files }))).toEqual(files);
});

test("project parsing requires real launch/build scripts and string file contents", () => {
  const invalid: unknown[] = [null, [], {}, { files: [] }, { files: { "index.html": "page" } },
    { files: { "package.json": "{}" } }, { files: { "package.json": "invalid" } },
    { files: { "package.json": JSON.stringify({ scripts: { dev: "vite" } }) } },
    { files: { "package.json": JSON.stringify({ scripts: { dev: " ", build: "vite build" } }) } },
    { files: { "package.json": packageJson, "source.ts": 4 } }];
  for (const value of invalid) expect(templateFiles(JSON.stringify(value))).toBeNull();
  expect(templateFiles("not json")).toBeNull();
});

test("project paths cannot escape or alias the workspace root", () => {
  for (const path of ["/absolute.ts", "../escape.ts", "src/../escape.ts", "src//file.ts", "", "src\\file.ts", "bad\0file.ts"]) {
    expect(templateFiles(JSON.stringify({ files: { "package.json": packageJson, [path]: "source" } }))).toBeNull();
  }
});

for (const template of templates) {
  test(`${template.label} has a source-only Vite 8 project with real package scripts`, async () => {
    const root = join(import.meta.dir, "../../sandbox", template.directory);
    const files: Record<string, string> = {};
    for (const path of new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })) files[path] = await Bun.file(join(root, path)).text();
    expect(templateFiles(JSON.stringify({ files }))).toEqual(files);
    expect(files[template.editorFile]).toBeDefined();
    expect(Object.keys(files).some(path => path.startsWith("node_modules/"))).toBe(false);
    const manifest: unknown = JSON.parse(files["package.json"]!);
    expect(manifest).toMatchObject({
      scripts: { dev: "vite --host 127.0.0.1 --port 5173 --strictPort", build: "vite build" },
      devDependencies: { vite: "8.3.5" },
    });
  });
}
