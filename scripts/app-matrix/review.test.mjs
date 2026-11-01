import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { apps } from "./apps.mjs";
import { checkCommand, checkInstall } from "./checks.mjs";
import { failure, compareEngines, stageOutput } from "./classify.ts";
import { readGuest, serverCommand } from "./browser.mjs";

test("playground server exit zero before HTTP assertion fails", async () => {
  const page = { evaluate: async (fn, text) => {
    if (text) return;
    return fn.toString().includes("serving:") ? { done: true, serving: false } : 0;
  } };
  const result = await serverCommand({ page, context: { newPage() { throw new Error("Must not assert preview after exit"); } }, command: { name: "start", args: ["run", "server.ts"], check: { kind: "http", text: "matrix" } }, options: { timeout: 1000 }, terminalText: async () => "$ bun run .matrix-command.ts server.ts\n$" });
  expect(result).toMatchObject({ status: "fail", exit: 0 });
});

test("readGuest decodes the playground's asynchronous shared filesystem reads", async () => {
  const files = new Map([["/home/user/dist/out.txt", new TextEncoder().encode("built")]]);
  const previous = globalThis.playground;
  globalThis.playground = { fs: { readFile: async path => files.get(path) } };
  const page = { evaluate: async (fn, arg) => fn(arg) };
  try {
    expect(await readGuest(page, "dist/out.txt")).toBe("built");
    expect(await readGuest(page, "missing.txt")).toBeNull();
  } finally { globalThis.playground = previous; }
});

test("no-op launcher fails positive and negative tooling assertions and install", async () => {
  const noop = { code: spawnSync("/usr/bin/true").status, output: "" };
  for (const app of apps.filter(app => ["typescript", "eslint"].includes(app.id))) {
    expect((await checkInstall(app, noop, () => null)).status).toBe("fail");
    expect(app.commands.length).toBe(2);
    for (const command of app.commands) expect((await checkCommand(command, noop, () => null)).status).toBe("fail");
  }
});

test("diagnostics ignore code frames and earlier stages", () => {
  expect(failure('1 | require("node:child_process"); throw error\nReferenceError: module is not defined', "dev")).toEqual({ category: "d", blocker: "dev: ReferenceError: module is not defined" });
  expect(failure("memory allocation of 16777216 bytes failed", "install").category).toBe("d");
  const log = "$ bun install\nwarning: install failed warning\n$ bun run index.js\nReferenceError: module is not defined\n[1] $";
  expect(failure(stageOutput(log, "bun run index.js"), "start").blocker).toBe("start: ReferenceError: module is not defined");
});

test("Next rejection prefixes retain their actual diagnostic", () => {
  expect(failure("Trying to load next-swc for unsupported platforms linux/wasm32\nunhandledRejection SyntaxError: Unexpected token '.'", "build")).toEqual({ category: "d", blocker: "build: SyntaxError: Unexpected token '.'" });
  expect(failure("unhandledRejection Error: No such module: fs", "build")).toEqual({ category: "c", blocker: "Error: No such module: fs" });
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


test("retained Next, Prisma and playground logs classify actual current diagnostics", () => {
  const log = name => readFileSync(join(import.meta.dir, "review-evidence", name), "utf8");
  expect(failure(log("next-quickjs-dev.log"), "dev")).toEqual({ category: "d", blocker: "dev: ReferenceError: module is not defined" });
  expect(failure(log("prisma-quickjs-install.log"), "install").category).toBe("d");
  const current = stageOutput(log("vite-react-quickjs-playground.log").replaceAll("user@bun:~$", "$"), "bun run node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3137");
  expect(current).not.toContain("optional dependency");
  expect(failure(current, "dev")).toMatchObject({ category: "a" });
  expect(failure(current, "dev").blocker).toStartWith('error: Your current platform');
});


test("package verification normalizes npm main paths for the playground filesystem", async () => {
  const app = { dependencies: { pkg: "1.0.0" }, commands: [] };
  const files = { "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", version: "1.0.0", main: "./index.cjs" }), "node_modules/pkg/index.cjs": "exports.ok = true" };
  const read = path => files[path] ?? null;
  expect((await checkInstall(app, { code: 0 }, read)).status).toBe("pass");
  expect((await checkInstall({ ...app, dependencies: { pkg: "2.0.0" } }, { code: 0 }, read)).status).toBe("fail");
  delete files["node_modules/pkg/index.cjs"];
  expect((await checkInstall(app, { code: 0 }, read)).status).toBe("fail");
});


test("playground server exiting during the page assertion also fails", async () => {
  const page = { evaluate: async (fn, text) => {
    if (text) return;
    const source = fn.toString();
    if (source.includes("serving:")) return { done: false, serving: true };
    if (source.includes("previews.url")) return "http://127.0.0.1/preview";
    if (source.includes("previews.ready")) return "ready";
    return source.includes("shell.lastExit") ? 0 : true;
  } };
  const preview = { on() {}, exposeBinding: async () => ({ dispose: async () => {} }), addInitScript: async () => ({ dispose: async () => {} }), evaluate: async () => {}, goto: async () => ({ ok: () => true, fromServiceWorker: () => true }), locator: () => ({ filter: () => ({ waitFor: async () => {} }) }), close: async () => {} };
  const probe = { context: () => ({ newCDPSession: async () => ({ send: async () => {} }) }), goto: async () => ({ ok: () => true, status: () => 200 }), close: async () => {} };
  const pages = [preview, probe];
  const result = await serverCommand({ page, context: { newPage: async () => pages.shift() }, command: { name: "start", args: ["run", "server.ts"], check: { kind: "http", text: "matrix" } }, options: { timeout: 1000 }, terminalText: async () => "$ bun run .matrix-command.ts server.ts\n$" });
  expect(result).toMatchObject({ status: "fail", exit: 0 });
});

test("bracketed Next build errors retain their diagnostic", () => {
  expect(failure("Build error occurred\n[TypeError: _promises.default.opendir is not a function]", "build")).toEqual({ category: "d", blocker: "build: TypeError: _promises.default.opendir is not a function" });
});

test("rejection diagnostics recognize bracketed errors", () => {
  for (const prefix of ["unhandledRejection", "uncaughtException"]) {
    for (const wrapped of [false, true]) {
      const error = "ReferenceError: WebAssembly is not defined";
      const output = "warning: unsupported architecture\n" + prefix + " " + (wrapped ? "[" + error + "]" : error);
      expect(failure(output, "build")).toEqual({ category: "d", blocker: "build: " + error });
    }
  }
});


test("declaration-only dependencies with empty main still require exact package identity", async () => {
  const app = { dependencies: { "@types/node": "22.18.10" }, commands: [] };
  const metadata = { name: "@types/node", version: "22.18.10", main: "", types: "index.d.ts" };
  const read = path => path === "node_modules/@types/node/package.json" ? JSON.stringify(metadata) : null;
  expect((await checkInstall(app, { code: 0 }, read)).status).toBe("pass");
  expect((await checkInstall(app, { code: 0 }, () => null)).status).toBe("fail");
  metadata.version = "22.18.9";
  expect((await checkInstall(app, { code: 0 }, read)).status).toBe("fail");
});
