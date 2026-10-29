import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditRepository, auditSourcePaths, parseLegacyInventory, parseRuntimeInputInventory, type SourceViolation } from "./typescript-sources";

const root = resolve(import.meta.dir, "..");

function violationKinds(paths: readonly string[], legacy: readonly string[] = [], baselineLegacy?: readonly string[]): SourceViolation["kind"][] {
  return auditSourcePaths({ paths, legacy, baselineLegacy }).map(violation => violation.kind);
}

test("tracked JavaScript is generated, a deliberate runtime input, or shrinking legacy source", () => {
  expect(auditRepository(root)).toEqual([]);
});

test("new handwritten JavaScript is rejected in runtime, scripts, web and test helpers", () => {
  const paths = [
    "crates/bunwasm-runtime/src/js/new-module.js",
    "scripts/new-helper.mjs",
    "web/src/new-host.cjs",
    "web/scripts/new-helper.mjs",
    "web/tests/new-helper.test.js",
    "tests/new-helper.js",
    "tests/helpers/new-helper.mjs",
  ];
  expect(violationKinds(paths)).toEqual(paths.map(() => "new-source"));
});

test("host helpers inside former runtime-input directories are rejected", () => {
  const paths = [
    "tests/fixtures/review-host-helper.mjs",
    "tests/build/review-host-helper.mjs",
    "tests/bench/review-host-helper.mjs",
    "tests/builtins/review-host-helper.mjs",
    "tests/transpiler-hooks/review-host-helper.mjs",
    "docs/app-matrix/repros/review-host-helper.mjs",
  ];
  expect(violationKinds(paths)).toEqual(paths.map(() => "new-source"));
});

test("new deliberate runtime inputs and generated outputs stay legal", () => {
  const runtimeInputs = [
    "tests/fixtures/new-fixture/index.js",
    "tests/fixtures/new-fixture/helper.mjs",
    "tests/build/assets/src/new-input.cjs",
    "tests/builtins/new-input.js",
    "tests/transpiler-hooks/new-input.mjs",
  ];
  const paths = [
    "crates/bunwasm-build/generated/new-client.js",
    "crates/bunwasm-runtime/generated/builtins/999.js",
  ].concat(runtimeInputs);
  expect(auditSourcePaths({ paths, legacy: [], baselineLegacy: [], runtimeInputs })).toEqual([]);
});

test("deleting legacy JavaScript or renaming it to TypeScript shrinks the inventory", () => {
  expect(auditSourcePaths({ paths: [], legacy: [], baselineLegacy: ["scripts/old-helper.mjs"] })).toEqual([]);
  expect(auditSourcePaths({ paths: ["scripts/old-helper.ts"], legacy: [], baselineLegacy: ["scripts/old-helper.mjs"] })).toEqual([]);
});

test("stale legacy inventory entries fail", () => {
  expect(auditSourcePaths({ paths: [], legacy: ["scripts/old-helper.mjs"], baselineLegacy: ["scripts/old-helper.mjs"] })).toEqual([
    { kind: "stale-inventory", path: "scripts/old-helper.mjs" },
  ]);
});

test("the legacy inventory cannot grow to admit new JavaScript", () => {
  expect(auditSourcePaths({ paths: ["scripts/new-helper.mjs"], legacy: ["scripts/new-helper.mjs"], baselineLegacy: [] })).toEqual([
    { kind: "inventory-growth", path: "scripts/new-helper.mjs" },
  ]);
});

test("renaming legacy JavaScript to another JavaScript path is not a shrinking migration", () => {
  expect(violationKinds(["scripts/new-helper.cjs"], ["scripts/new-helper.cjs"], ["scripts/old-helper.mjs"])).toEqual(["inventory-growth"]);
});

test("stale runtime-input inventory entries fail", () => {
  expect(auditSourcePaths({ paths: [], legacy: [], runtimeInputs: ["tests/fixtures/old-input.js"] })).toEqual([
    { kind: "stale-inventory", path: "tests/fixtures/old-input.js" },
  ]);
});

test("the esbuild Playwright controller is legacy while its guest inputs stay runtime inputs", () => {
  const legacy = parseLegacyInventory(readFileSync(resolve(root, "scripts/typescript-source-legacy.txt"), "utf8"));
  const runtimeInputs = parseRuntimeInputInventory(readFileSync(resolve(root, "scripts/typescript-source-runtime-inputs.txt"), "utf8"));
  expect(legacy).toContain("tests/esbuild/browser.mjs");
  expect(runtimeInputs).not.toContain("tests/esbuild/browser.mjs");
  for (const path of ["tests/esbuild/check.cjs", "tests/esbuild/sync.cjs", "tests/esbuild/watch.cjs"]) expect(runtimeInputs).toContain(path);
});

test("legacy inventory is sorted, unique JavaScript paths", () => {
  expect(parseLegacyInventory("scripts/a.mjs\nscripts/b.js\n")).toEqual(["scripts/a.mjs", "scripts/b.js"]);
  expect(() => parseLegacyInventory("scripts/b.js\nscripts/a.mjs\n")).toThrow("sorted");
  expect(() => parseLegacyInventory("scripts/a.mjs\nscripts/a.mjs\n")).toThrow("sorted");
  expect(() => parseLegacyInventory("scripts/a.ts\n")).toThrow("JavaScript");
});
