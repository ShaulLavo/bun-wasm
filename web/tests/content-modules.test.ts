import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { ContentModules } from "../src/content-modules";

const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) rmSync(path, { recursive: true, force: true }); });
const contentUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;

test("acyclic modules import without a named store and keep shared dependency identity", async () => {
  let builds = 0;
  const modules = new ContentModules({
    named: { url() { throw new Error("module requires HTTP"); }, put() { throw new Error("module requires Cache Storage"); } },
    paths: new Map(), storing: [], contentUrl,
    source(key) {
      if (key === "dep") { builds++; return "export const value = {};"; }
      const first = JSON.stringify(modules.ensure("dep"));
      const second = JSON.stringify(modules.ensure("dep"));
      return `import {value as first} from ${first}; import {value as second} from ${second}; export default first === second;`;
    },
  });
  expect((await import(modules.ensure("main"))).default).toBe(true);
  expect(builds).toBe(1);
});

test("failed graphs roll back cached children before a retry", async () => {
  const scratch = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const root = mkdtempSync(join(scratch, "bun-wasm-content-modules-retry-"));
  owned.push(root);
  const writes: Promise<unknown>[] = [];
  const paths = new Map<string, string>();
  let missing = false;
  let modules: ContentModules;
  const named = {
    url(key: string) { return pathToFileURL(join(root, `${key}.mjs`)).href; },
    put(url: string, source: string) { return writeFile(new URL(url), source); },
  };
  modules = new ContentModules({
    named, paths, storing: writes, contentUrl,
    source(key) {
      if (key === "a") {
        const dependency = modules.ensure("b");
        if (!missing) throw Object.assign(new Error("Cannot find module ./missing.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
        modules.ensure("missing");
        return `import {b} from ${JSON.stringify(dependency)}; export function a() { return 'a'; } export const result = b();`;
      }
      if (key === "b") {
        const rootUrl = modules.ensure("a");
        return `import {a} from ${JSON.stringify(rootUrl)}; export function b() { return a() + "b"; }`;
      }
      return "export function a() { return 'a'; }";
    },
  });
  expect(() => modules.ensure("a")).toThrow(expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }));
  missing = true;
  const entry = modules.ensure("a");
  await Promise.all(writes.splice(0));
  const imported = spawnSync("node", ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(entry)})).result)`], { encoding: "utf8" });
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("ab");
  expect(paths.get(entry)).toBe("a");
});

test("cyclic modules retain native hoisting through a named back edge", async () => {
  const scratch = process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const root = mkdtempSync(join(scratch, "bun-wasm-content-modules-"));
  owned.push(root);
  const writes: Promise<unknown>[] = [];
  const named: string[] = [];
  const paths = new Map<string, string>();
  const modules = new ContentModules({
    named: {
      url(key) { named.push(key); return pathToFileURL(`${root}/${key}.mjs`).href; },
      put(url, source) { return writeFile(new URL(url), source); },
    },
    paths, storing: writes, contentUrl,
    source(key) {
      if (key === "a") return `import {b} from ${JSON.stringify(modules.ensure("b"))}; export function a() { return 'a'; } export const result = b();`;
      return `import {a} from ${JSON.stringify(modules.ensure("a"))}; export function b() { return a() + 'b'; }`;
    },
  });
  const entry = modules.ensure("a");
  await Promise.all(writes);
  const imported = spawnSync("node", ["--input-type=module", "-e", `console.log((await import(${JSON.stringify(entry)})).result)`], { encoding: "utf8" });
  expect(imported.stderr).toBe("");
  expect(imported.status).toBe(0);
  expect(imported.stdout.trim()).toBe("ab");
  expect(named).toEqual(["a"]);
  expect(paths.get(entry)).toBe("a");
});

test("cycles without a named store still report ERR_CIRCULAR_IMPORT", () => {
  const modules = new ContentModules({ paths: new Map(), storing: [], contentUrl, source: key => modules.ensure(key) });
  expect(() => modules.ensure("a")).toThrow(expect.objectContaining({ code: "ERR_CIRCULAR_IMPORT" }));
});
