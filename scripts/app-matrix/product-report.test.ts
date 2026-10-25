import { expect, test } from "bun:test";
import { firstError } from "./classify";
import { observedSignature, productScoreboard, unlockCandidates, type ProductResultRow } from "./product-report";

test("baseline cannot count native/reference results as browser product passes", () => {
  const rows = [{ app: "vite", engine: "browser", host: "native", stage: "install", status: "pass" }] satisfies ProductResultRow[];
  expect(productScoreboard(rows, [{ id: "vite", commands: [{ name: "dev", check: { kind: "page", hmr: {} } }] }])).toContain("| vite | Not run | Not run | Not run |");
});

test("unlock ranking counts distinct failing projects, not downstream blocked stages", () => {
  const rows = [
    { app: "react", engine: "browser", host: "playground", stage: "dev", status: "fail", blocker: "HTTP 500" },
    { app: "react", engine: "browser", host: "playground", stage: "build", status: "fail", blocker: "HTTP 500" },
    { app: "vue", engine: "browser", host: "playground", stage: "dev", status: "fail", blocker: "HTTP 500" },
    { app: "next", engine: "browser", host: "playground", stage: "dev", status: "blocked", blocker: "HTTP 500" },
  ] satisfies ProductResultRow[];
  expect(unlockCandidates(rows)[0]?.projects).toEqual(["react", "vue"]);
  expect(unlockCandidates(rows)[0]?.confidence).toContain("need confirmation");
});

test("partial tool command groups cannot become a complete pass", () => {
  const rows = [
    { app: "typescript", engine: "browser", host: "playground", stage: "install", status: "pass" },
    { app: "typescript", engine: "browser", host: "playground", stage: "check", status: "pass" },
  ] satisfies ProductResultRow[];
  const project = { id: "typescript", commands: ["check", "reject", "build", "run"].map(name => ({ name, check: { kind: "stdout" } })) };
  expect(productScoreboard(rows, [project])).toContain("| typescript | Pass | Not applicable | Not applicable | Not run | Not applicable |");
});

test("native reference failures do not enter the browser unlock ranking", () => {
  const rows = [
    { app: "native-only", engine: "reference", host: "native", stage: "build", status: "fail", blocker: "HTTP 500" },
    { app: "native-only", engine: "browser", host: "playground", stage: "build", status: "pass" },
  ] satisfies ProductResultRow[];
  expect(unlockCandidates(rows)).toEqual([]);
});

test("OS-shaped diagnostics are observations, not proven ownership", () => {
  expect(observedSignature("EACCES loading app-only file").owner).toBe("Unconfirmed");
  expect(observedSignature("ENOSYS socket operation").owner).toBe("Unconfirmed");
});

test("the real unsupported API error is retained before a later browser navigation timeout", () => {
  expect(firstError("Unhandled Rejection: Error: inspector.url is not supported in bun-wasm: no debugger\nTimeoutError: goto exceeded")).toBe("Error: inspector.url is not supported in bun-wasm: no debugger");
});
