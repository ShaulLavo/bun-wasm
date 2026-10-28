import { expect, test } from "bun:test";
import { firstError } from "./classify";
import { networkGuardStage } from "./product-campaign";
import { observedSignature, productScoreboard, unlockCandidates, type ProductResultRow } from "./product-report";

test("baseline cannot count native/reference results as browser product passes", () => {
  const rows = [{ app: "vite", engine: "browser", host: "native", stage: "install", status: "pass" }] satisfies ProductResultRow[];
  expect(productScoreboard(rows, [{ id: "vite", commands: [{ name: "dev", check: { kind: "page", hmr: {} } }] }])).toContain("| vite | Not run | Not run | Not run |");
});

test.each(["jsc", "quickjs"])("scoreboard labels recorded %s playground results and preserves stage outcomes", engine => {
  const rows = [
    { app: "vite", engine, host: "playground", stage: "install", status: "pass" },
    { app: "vite", engine, host: "playground", stage: "dev", status: engine === "jsc" ? "pass" : "fail" },
    { app: "vite", engine, host: "playground", stage: "dev:hmr", status: "blocked" },
    { app: "vite", engine, host: "playground", stage: "build", status: "pass" },
    { app: "vite", engine, host: "native", stage: "preview", status: "pass" },
  ] satisfies ProductResultRow[];
  const project = { id: "vite", commands: [{ name: "dev", check: { kind: "page", hmr: {} } }, { name: "build", check: { kind: "stdout" } }, { name: "preview", check: { kind: "page" } }] };
  const report = productScoreboard(rows, [project, { id: "unmeasured", commands: project.commands }]);
  expect(report).toStartWith("| Project | Engine | Install |");
  expect(report).toContain(`| vite | ${engine} | Pass | ${engine === "jsc" ? "Pass" : "Fail"} | Blocked | Pass | Not run |`);
  expect(report).toContain(`| unmeasured | ${engine} | Not run | Not run | Not run | Not run | Not run |`);
});

test("mixed engines keep contradictory outcomes and partial command groups separate", () => {
  const rows = [
    { app: "tools", engine: "jsc", host: "playground", stage: "install", status: "pass" },
    { app: "tools", engine: "jsc", host: "playground", stage: "check", status: "pass" },
    { app: "tools", engine: "quickjs", host: "playground", stage: "install", status: "fail" },
    { app: "tools", engine: "quickjs", host: "playground", stage: "build", status: "pass" },
    { app: "tools", engine: "browser", host: "playground", stage: "install", status: "blocked" },
    { app: "tools", engine: "reference", host: "native", stage: "install", status: "pass" },
  ] satisfies ProductResultRow[];
  const project = { id: "tools", commands: ["check", "build"].map(name => ({ name, check: { kind: "stdout" } })) };
  expect(productScoreboard(rows, [project])).toBe([
    "| Project | Engine | Install | Dev/page | Hot edit | Build/tool | Start/preview |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| tools | jsc | Pass | Not applicable | Not applicable | Not run | Not applicable |",
    "| tools | quickjs | Fail | Not applicable | Not applicable | Not run | Not applicable |",
    "| tools | browser | Blocked | Not applicable | Not applicable | Not run | Not applicable |",
    "",
  ].join("\n"));
});

test("network measurement errors affect only the recorded engine", () => {
  const rows = [
    { app: "vite", engine: "jsc", host: "playground", stage: "install", status: "pass" },
    { app: "vite", engine: "jsc", host: "playground", stage: networkGuardStage, status: "fail" },
    { app: "vite", engine: "browser", host: "playground", stage: "install", status: "pass" },
  ] satisfies ProductResultRow[];
  const report = productScoreboard(rows, [{ id: "vite", commands: [{ name: "dev", check: { kind: "page" } }] }]);
  expect(report).toContain("| vite | jsc | Measurement error | Measurement error | Not applicable | Not applicable | Not applicable |");
  expect(report).toContain("| vite | browser | Pass | Not run | Not applicable | Not applicable | Not applicable |");
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
