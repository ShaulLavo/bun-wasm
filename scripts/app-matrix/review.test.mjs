import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { apps } from "./apps.mjs";
import { checkCommand, checkInstall } from "./checks.mjs";
import { failure, compareEngines, stageOutput } from "./classify.mjs";
import { earlyServerExit } from "./browser.mjs";

test("playground server exit zero before HTTP assertion fails", () => {
  expect(earlyServerExit({ code: 0, output: "" }, "start").status).toBe("fail");
});

test("no-op launcher fails positive and negative tooling assertions and install", async () => {
  for (const app of apps.filter(app => ["typescript", "eslint"].includes(app.id))) {
    expect((await checkInstall(app, { code: 0, output: "" }, () => null)).status).toBe("fail");
    expect(app.commands.length).toBe(2);
    for (const command of app.commands) expect((await checkCommand(command, { code: 0, output: "" }, () => null)).status).toBe("fail");
  }
});

test("diagnostics ignore code frames and earlier stages", () => {
  expect(failure('1 | require("node:child_process"); throw error\nReferenceError: module is not defined', "dev")).toEqual({ category: "d", blocker: "dev: ReferenceError: module is not defined" });
  expect(failure("memory allocation of 16777216 bytes failed", "install").category).toBe("d");
  const log = "user@bun:~$ bun install\nwarning: install failed warning\nuser@bun:~$ bun run index.js\nReferenceError: module is not defined\n[1] user@bun:~$";
  expect(failure(stageOutput(log, "bun run index.js"), "start").blocker).toBe("start: ReferenceError: module is not defined");
});

test("measured engine comparison marks only QuickJS failures f", () => {
  const rows = [
    { app: "prettier", host: "playground", stage: "check", engine: "quickjs", status: "fail", category: "c" },
    { app: "prettier", host: "playground", stage: "check", engine: "jsc", status: "pass" },
    { app: "prettier", host: "playground", stage: "check", engine: "browser", status: "fail", category: "c" },
  ];
  expect(compareEngines(rows)[0]).toMatchObject({ category: "f", passesOn: ["jsc"] });
  expect(compareEngines(rows)[2].category).toBe("c");
});
