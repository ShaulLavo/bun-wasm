import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Sandbox } from "../sandbox/src/sandbox";
import { templates } from "../sandbox/src/template-catalog";
import { Playground } from "../web/src/playground/playground";
import { projectTemplates } from "../web/src/playground/project-templates";
import { templateProfile } from "../web/src/playground/program-profile";
import { needsSharedNative } from "./ci-changes";

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
beforeEach(() => Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") }));
afterEach(() => {
  if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
  else Reflect.deleteProperty(globalThis, "location");
});

const engines = ["browser", "quickjs", "jsc", "spidermonkey"] as const;

for (const template of projectTemplates) test(`${template.id} uses one worker policy in both pages`, () => {
  for (const engine of engines) {
    const profile = template.sharedWorkers && engine !== "browser" ? "shared-group" : "split";
    expect(templateProfile(engine, template.id)).toBe(profile);
    expect(new Playground(`?engine=${engine}&template=${template.id}`).profile).toBe(profile);
    expect(new Sandbox(`?engine=${engine}&template=${template.id}`).profile).toBe(profile);
    expect(templateProfile(engine, template.id, "split")).toBe("split");
  }
});

test("the sandbox default and its Vite 8 vanilla entry use the common catalog", () => {
  expect(new Sandbox("?engine=quickjs").profile).toBe("shared-group");
  expect(new Sandbox("").profile).toBe("split");
  expect(new Sandbox("?engine=quickjs&profile=split").profile).toBe("split");
  for (const template of templates) expect(projectTemplates.some(item => item.id === template.id)).toBe(true);
  expect(() => new Sandbox("?engine=browser&profile=shared-group")).toThrow("does not support");
  expect(() => new Sandbox("?engine=quickjs&profile=shared")).toThrow("Unknown Bun program memory profile");
});

test("the declared worker templates match the maintained Rolldown, Angular and Nuxt inputs", async () => {
  for (const template of projectTemplates) {
    const manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = JSON.parse(await readFile(join(import.meta.dir, "../sandbox", template.directory, "package.json"), "utf8"));
    const vite = manifest.devDependencies?.vite ?? manifest.dependencies?.vite;
    const sharedWorkers = template.id === "angular" || typeof manifest.dependencies?.nuxt === "string" || (typeof vite === "string" && Number(vite.split(".")[0]) >= 8);
    expect({ id: template.id, sharedWorkers: template.sharedWorkers }).toEqual({ id: template.id, sharedWorkers });
  }
});

test("Nuxt's Oxc shared memory requirement keeps overrides and Browser's split profile", () => {
  for (const engine of engines) {
    const expected = engine === "browser" ? "split" : "shared-group";
    expect(templateProfile(engine, "nuxt")).toBe(expected);
    expect(new Playground(`?engine=${engine}&template=nuxt&profile=split`).profile).toBe("split");
    expect(new Sandbox(`?engine=${engine}&template=nuxt&profile=split`).profile).toBe("split");
    if (engine === "browser") continue;
    expect(templateProfile(engine, "nuxt", "shared-group")).toBe("shared-group");
  }
  expect(() => templateProfile("browser", "nuxt", "shared-group")).toThrow("does not support");
  expect(() => new Playground("?engine=browser&template=nuxt&profile=shared-group")).toThrow("does not support");
  expect(() => new Sandbox("?engine=browser&template=nuxt&profile=shared-group")).toThrow("does not support");
});

test("worker policy edits select the blocking shared producer and browser check", () => {
  for (const path of ["web/src/playground/project-templates.ts", "web/src/playground/program-profile.ts", "sandbox/src/template-catalog.ts", "sandbox/src/sandbox.ts"]) {
    expect(needsSharedNative([path])).toBe(true);
  }
});
