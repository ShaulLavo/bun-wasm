// Browser-guest check: the worker module loader in Chromium and WebKit, on the playground site
// built from this checkout's browser guest (scripts/browser-guest-site.ts). CI's rust job builds
// that site once and each browser leg passes it in BUN_WASM_BROWSER_SITE; the check verifies its
// closed inventory and source before and after the browsers run and never bundles it again.
// A local run without BUN_WASM_BROWSER_SITE builds one in scratch from dist/bun-browser.wasm.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSite, verifySite } from "./browser-guest-site";

const root = resolve(import.meta.dir, "..");

test("worker ES module cycles load without a service-worker controller, on this checkout's site", () => {
  const provided = process.env.BUN_WASM_BROWSER_SITE;
  if (process.env.CI && !provided) throw new Error("CI must pass the rust job's site in BUN_WASM_BROWSER_SITE");
  const scratch = provided ? undefined : mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-browser-site-"));
  const out = provided ? resolve(provided) : scratch!;
  try {
    const before = provided ? verifySite(out) : buildSite(out);
    console.log(JSON.stringify({ source: before.source, guest: before.guest, files: Object.keys(before.files).length }));
    const browsers = (process.env.BUN_WASM_TEST_BROWSERS ?? "chromium,webkit").split(",");
    execFileSync(process.execPath, ["tests/browser-module-records.ts"].concat(browsers), {
      cwd: join(root, "web"), stdio: "inherit", env: { ...process.env, MODULE_RECORDS_ROOT: join(out, "site") },
    });
    expect(verifySite(out)).toEqual(before);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}, 900_000);

test("actual createRecords uses import-only resolution for graph preparation and linking", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { createModuleRecords } = await import("../web/src/module-records.ts");
  const { loaderSource } = await import("./esm-loader-harness.ts");
  const text = readFileSync(join(root, "web/src/engine-host.js"), "utf8");
  const start = text.indexOf("  createRecords() {");
  const end = text.indexOf("  // --- ES modules ---", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const method: unknown = new Function("createModuleRecords", "uncurryThis", "wrapperKeys", `return ({${text.slice(start, end)}}).createRecords`)(
    createModuleRecords, (fn: Function) => Function.prototype.call.bind(fn), Object.keys,
  );
  if (typeof method !== "function") throw new Error("Expected EngineHost.createRecords");
  const token = "bunwasm:request:0";
  const logical = "bunwasm:text:0";
  const calls: string[] = [];
  const records = {
    "/entry.mjs": `export default {r:[${JSON.stringify(token)}],i:[[0,"default"]],x:[],s:[],e:[["default","page"]],a:false,
      f:function*(api){let page;api.l({page:()=>page});yield;yield;page=api.n[0].default;}}`,
    [logical]: 'export default {r:[],i:[],x:[],s:[],e:[["default","page"]],a:false,f:function*(api){let page;api.l({page:()=>page});yield;yield;page="exact text";}}',
  };
  const factory: unknown = new Function(`return (${loaderSource()})`)();
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-text-records-"));
  let sequence = 0;
  const host = {
    exited: false,
    native: {
      resolve() { throw new Error("CommonJS resolver must not receive static tokens"); },
      resolveImport(specifier: string, referrer: string, mode: string) {
        calls.push(`${specifier}|${referrer}|${mode}`);
        if (specifier !== token || referrer !== "/entry.mjs" || mode !== "inferred") throw new Error("Unexpected logical request");
        return logical;
      },
      hostModuleRecord(key: keyof typeof records) { return { format: "esm", record: records[key] }; },
    },
    internal: { mainPath: "/entry.mjs", initImportMeta() {} },
    evalPolyfill: () => factory,
    url(code: string) {
      const path = join(scratch, `${sequence++}.mjs`);
      writeFileSync(path, code);
      return path;
    },
    track: (promise: Promise<object>) => promise,
    handoff(key: string, format: string) { throw new Error(`Text must be ESM, never a CommonJS handoff: ${key} ${format} calls=${calls}`); },
  };
  const loaded = Reflect.apply(method, host, []);
  try {
    const namespace = await loaded.importKey("/entry.mjs");
    expect(namespace.default).toBe("exact text");
    expect(calls.filter(call => call.startsWith(token)).length).toBeGreaterThanOrEqual(2);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
