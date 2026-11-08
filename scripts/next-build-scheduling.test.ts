import { expect, test } from "bun:test";

const stable = ["app-page", "app-route", "pages", "pages-api", "server"].map(name => `next/dist/compiled/next-server/${name}.runtime.prod.js`);
const alternate = [
  "app-page-experimental", "app-page-turbo-experimental", "app-page-turbo",
  "app-route-experimental", "app-route-turbo-experimental", "app-route-turbo",
  "pages-api-turbo", "pages-turbo",
].map(name => `next/dist/compiled/next-server/${name}.runtime.prod.js`);

test("the pinned webpack starter traces stable runtimes, not alternate bundlers or React channels", async () => {
  const { default: config } = await import(new URL("../sandbox/template-next/next.config.ts", import.meta.url).href);
  expect(config).toEqual({ experimental: { cpus: 1 }, outputFileTracingExcludes: { "next-server": alternate.map(file => `**/${file}`) } });
  const omitted = config.outputFileTracingExcludes?.["next-server"] ?? [];
  const traced = stable.concat(alternate).filter(file => !omitted.some((pattern: string) => new Bun.Glob(pattern).match(`/home/user/node_modules/${file}`)));
  expect(traced).toEqual(stable);
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableRuntimes, alternateRuntimes, assertRuntimeTrace, tracedFiles, selectedRuntime } from "./next-trace-fixture";

test("trace checks reject a required omission and an alternate-runtime leak", () => {
  const complete = new Set(stableRuntimes);
  expect(() => assertRuntimeTrace(complete)).not.toThrow();
  for (const path of stableRuntimes) expect(() => assertRuntimeTrace(new Set(stableRuntimes.filter(file => file !== path)))).toThrow("Required stable runtime missing");
  for (const path of alternateRuntimes) expect(() => assertRuntimeTrace(new Set(stableRuntimes.concat([path])))).toThrow("Unused alternate runtime remains traced");
});

test("trace inventory follows manifest-relative paths and rejects escaping dependencies", () => {
  const project = mkdtempSync(join(tmpdir(), "bun-wasm-next-trace-"));
  try {
    mkdirSync(join(project, ".next/server/pages"), { recursive: true });
    writeFileSync(join(project, ".next/next-server.js.nft.json"), JSON.stringify({ files: stableRuntimes.map(path => `../${path}`) }));
    expect(tracedFiles(project)).toEqual(new Set(stableRuntimes));
    writeFileSync(join(project, ".next/server/pages/index.js.nft.json"), JSON.stringify({ files: ["../../../../outside.js"] }));
    expect(() => tracedFiles(project)).toThrow("Trace escapes project");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("runtime selection observes the package's production, bundler, and React-channel branches", () => {
  const source = `module.exports = require(process.env.TURBOPACK ? "turbo" : process.env.__NEXT_EXPERIMENTAL_REACT ? "experimental" : process.env.NODE_ENV === "production" ? "stable" : "dev");`;
  expect(selectedRuntime(source, { NODE_ENV: "production" })).toBe("stable");
  expect(selectedRuntime(source, { NODE_ENV: "production", TURBOPACK: "1" })).toBe("turbo");
  expect(selectedRuntime(source, { NODE_ENV: "production", __NEXT_EXPERIMENTAL_REACT: "1" })).toBe("experimental");
});

test("staging copies only traced dependencies, not an available full package", () => {
  const project = mkdtempSync(join(tmpdir(), "bun-wasm-next-selection-"));
  const destination = join(project, "restricted");
  const write = (path: string, value: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, value); };
  try {
    for (const name of ["next", "react", "react-dom"]) write(join(project, "node_modules", name, "package.json"), JSON.stringify({ version: name === "next" ? "15.5.6" : "19.1.1" }));
    for (const path of stableRuntimes) write(join(project, path), "required");
    for (const path of alternateRuntimes) write(join(project, path), "not selected");
    for (const kind of ["app-page", "app-route", "pages", "pages-api"]) write(join(project, `node_modules/next/dist/server/route-modules/${kind}/module.compiled.js`), `module.exports = require("next/dist/compiled/next-server/${kind}.runtime.prod.js");`);
    write(join(project, "node_modules/next/dist/lib/needs-experimental-react.js"), "exports.needsExperimentalReact = config => Boolean(config.experimental?.ppr);");
    write(join(project, "node_modules/next/dist/bin/next"), "must not copy");
    write(join(project, "package.json"), "{}");
    write(join(project, ".next/required-server-files.json"), JSON.stringify({ config: { experimental: { cpus: 1 } } }));
    write(join(project, ".next/next-server.js.nft.json"), JSON.stringify({ files: stableRuntimes.map(path => `../${path}`) }));
    const { stageTrace } = require("./next-trace-fixture");
    expect(stageTrace(project, destination).dependencies).toBe(stableRuntimes.length);
    expect(tracedFiles(destination)).toEqual(new Set(stableRuntimes));
    for (const path of stableRuntimes) expect(Bun.file(join(destination, path)).size).toBe(8);
    for (const path of alternateRuntimes) expect(Bun.file(join(destination, path)).size).toBe(0);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
