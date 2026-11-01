import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { pairedEngines, isPairedEngine } from "../src/engine-kind.ts";
import { parseProgramInputs } from "./guest-core-receipt.ts";
import { guestBuilds, hash } from "./guest-source-manifest.ts";
import { completePublicationArtifactPaths, publicationAssets, publicationEngines, publicationGuestPaths, requireCompletePublicationFiles, verifyPublicationBuilds } from "./producer-closure.ts";
import { discoverChecks } from "./test-checks.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("normal publication has Browser, QuickJS and JSC, with both Browser profiles and tools", () => {
  expect(pairedEngines).toEqual(["quickjs", "jsc"]);
  expect(publicationEngines).toEqual(["quickjs", "jsc", "browser"]);
  expect(Object.keys(publicationGuestPaths)).toEqual(["browser", "source-cache-browser", "tools"]);
  expect(Object.keys(guestBuilds)).toEqual(["browser", "source-cache-browser", "quickjs", "quickjs-minimal", "jsc", "tools"]);
  for (const kind of ["hermes", "spidermonkey", "unknown"]) expect(isPairedEngine(kind)).toBe(false);
});

test("complete final custody requires all remaining guests, original receipts and matrix evidence", () => {
  const paths = completePublicationArtifactPaths();
  expect(paths.some(path => /hermes|spidermonkey/i.test(path))).toBe(false);
  expect(() => requireCompletePublicationFiles(paths.map(path => ({ path })))).not.toThrow();
  for (const path of paths) {
    expect(() => requireCompletePublicationFiles(paths.filter(other => other !== path).map(path => ({ path })))).toThrow(path);
  }
  for (const path of ["native/hermes/vm-library.json", "split/dist/bun-hermes.wasm", "split/web/hermes-engine.wasm.gz"]) {
    expect(() => requireCompletePublicationFiles(paths.concat([path]).map(path => ({ path })))).toThrow("Withdrawn engine");
  }
});

test("web publication fingerprints reject missing payloads and old engine references", () => {
  const builds = Object.fromEntries(publicationAssets.map(name => [name, "a".repeat(64)]));
  expect(() => verifyPublicationBuilds(builds)).not.toThrow();
  for (const name of publicationAssets) {
    const partial = { ...builds };
    delete partial[name];
    expect(() => verifyPublicationBuilds(partial)).toThrow("complete supported");
  }
  for (const name of ["bun-hermes.wasm", "hermes-engine.wasm", "bun-spidermonkey.wasm"]) {
    expect(() => verifyPublicationBuilds({ ...builds, [name]: "b".repeat(64) })).toThrow("complete supported");
  }
});

test("old Hermes program input receipts cannot become current paired-engine receipts", () => {
  const content = { selection: { kind: "hermes" }, synthetic: "metadata only, not accepted workload bytes" };
  const value = { schema: 1, scope: "hermes", source: { head: "a".repeat(40), tree: "b".repeat(40) }, content, contentSha256: hash(JSON.stringify(content)) };
  expect(() => parseProgramInputs(value)).toThrow("Invalid program input snapshot");
});

test("normal CI retires Hermes work instead of recording it as passed", () => {
  const workflow = read(".github/workflows/ci.yml");
  expect(workflow).not.toMatch(/hermes/i);
  expect(workflow).toContain("bun scripts/jsc-embedding.ts test dist/bun-jsc.wasm");
  expect(workflow).toContain("source-cache-browser-guest");
  expect(discoverChecks().filter(check => /^scripts\/hermes-/.test(check.path))).toEqual([]);
  expect(discoverChecks().filter(check => check.path === "scripts/no-hermes-publication.test.ts").map(check => check.owner)).toEqual(["quality"]);
});

test("shipped build and selectors cannot stage or register a dormant Hermes artifact", () => {
  for (const path of ["web/build.ts", "web/src/engine-loader.ts", "src/executable-paths.ts", "src/bun-adapter.ts", "web/src/bun-executor.ts", "web/src/subprocess-broker.ts", "web/scripts/node-spawn.ts", "scripts/app-matrix/run.mjs"]) {
    expect(read(path), path).not.toMatch(/hermes/i);
  }
  expect(read("web/src/playground/playground.ts")).toContain('requested !== null && !isEngine(requested)');
});

test("web staging ignores dormant files and preserves both required paired-side guards", async () => {
  const source = read("web/build.ts");
  const start = source.indexOf('if (!(await copyWasm(wasmSource, "bun.wasm")))');
  const end = source.indexOf("await buildShellAssets", start);
  if (start < 0 || end < 0) throw new Error("Missing web guest staging boundary");
  const stage = new Function("copyWasm", "existsSync", "resolve", "join", "dirname", "here", "process", "wasmSource", `return (async () => {${source.slice(start, end)}})();`);
  const copy = async (missing?: string) => {
    const names: string[] = [];
    await stage(async (_source: string, name: string) => { names.push(name); return name !== missing; }, () => true,
      resolve, join, (path: string) => resolve(path, ".."), "/synthetic/web", { env: { HERMES_WASM: "/old/bun-hermes.wasm" } }, "/synthetic/bun.wasm");
    return names;
  };
  expect((await copy()).sort()).toEqual(publicationAssets.toSorted());
  await expect(copy("quickjs.wasm")).rejects.toThrow("QuickJS core requires its matching side");
  await expect(copy("jsc-engine.wasm")).rejects.toThrow("JSC core requires its matching side");
});
