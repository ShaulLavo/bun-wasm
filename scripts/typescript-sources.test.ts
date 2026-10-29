import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { auditRepository, auditSourcePaths, parseLegacyInventory, type SourceViolation } from "./typescript-sources";

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

test("new deliberate runtime inputs and generated outputs stay legal", () => {
  const paths = [
    "crates/bunwasm-build/generated/new-client.js",
    "crates/bunwasm-runtime/generated/builtins/999.js",
    "tests/fixtures/new-fixture/index.js",
    "tests/fixtures/new-fixture/helper.mjs",
    "tests/build/assets/src/new-input.cjs",
    "tests/builtins/new-input.js",
    "tests/transpiler-hooks/new-input.mjs",
  ];
  expect(auditSourcePaths({ paths, legacy: [], baselineLegacy: [] })).toEqual([]);
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

test("legacy inventory is sorted, unique JavaScript paths", () => {
  expect(parseLegacyInventory("scripts/a.mjs\nscripts/b.js\n")).toEqual(["scripts/a.mjs", "scripts/b.js"]);
  expect(() => parseLegacyInventory("scripts/b.js\nscripts/a.mjs\n")).toThrow("sorted");
  expect(() => parseLegacyInventory("scripts/a.mjs\nscripts/a.mjs\n")).toThrow("sorted");
  expect(() => parseLegacyInventory("scripts/a.ts\n")).toThrow("JavaScript");
});
