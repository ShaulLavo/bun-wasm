import { expect, test } from "bun:test";
import { assertBunRuntimeProcDiagnostics } from "./bun-runtime-proc-diagnostics";

const diagnostic = "runtime: process controller failed Error: bun-runtime-proc-start-failed-control";

test("startup refusal has exactly one host console diagnostic and no uncaught page error", () => {
  expect(() => assertBunRuntimeProcDiagnostics("start-failed", [], [diagnostic])).not.toThrow();
  expect(() => assertBunRuntimeProcDiagnostics("start-failed", [], [diagnostic + "\n    at fixture (control.js:1:1)"])).not.toThrow();
});

for (const errors of [[], [diagnostic, diagnostic], ["unexpected"], [diagnostic + " unexpected"]]) {
  test(`startup refusal rejects missing, duplicated or unrelated console diagnostics: ${JSON.stringify(errors)}`, () => {
    expect(() => assertBunRuntimeProcDiagnostics("start-failed", [], errors)).toThrow();
  });
}

test("expected startup diagnostic cannot excuse an uncaught page error", () => {
  expect(() => assertBunRuntimeProcDiagnostics("start-failed", [diagnostic], [diagnostic])).toThrow();
});

test("other scenarios allow neither console errors nor uncaught page errors", () => {
  expect(() => assertBunRuntimeProcDiagnostics("inherited-descriptor-semantics", [], [])).not.toThrow();
  expect(() => assertBunRuntimeProcDiagnostics("inherited-descriptor-semantics", [], [diagnostic])).toThrow();
  expect(() => assertBunRuntimeProcDiagnostics("inherited-descriptor-semantics", ["unexpected"], [])).toThrow();
});
