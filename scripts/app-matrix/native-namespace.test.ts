import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext, runInNewContext } from "node:vm";
import * as guest from "./guest-command";
import { projectFiles } from "./apps.mjs";
import { fullstackApps } from "./product-fullstack";
import { HarnessCleanupError } from "./cleanup";

async function ownedScratch(run: (scratch: string) => Promise<void>): Promise<void> {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "bun-wasm-namespace-"));
  try { await run(scratch); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

function runner(scratch: string, execute: () => Promise<unknown> = async () => ({ status: "pass" })) {
  const source = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const declarations = ["prepare", "nativeStages", "nativeApp"].map(name => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, "m"));
    assert.ok(match, `Missing native ${name}`);
    return match[0];
  }).join("\n");
  const context = createContext({
    ...guest, scratch, projectFiles, mkdirSync, dirname, join, writeFileSync, rmSync, HarnessCleanupError,
    mirror: { base: "http://127.0.0.1:0" }, options: { output: scratch },
    guestCommand: (_engine: string, project: Parameters<typeof guest.guestCommand>[0]["project"], args: string[]) => guest.guestCommand({ host: ["/launcher", "--wasm", "/core.wasm"], project, args, port: 0, registry: "http://127.0.0.1:0" }),
    capture: async () => ({ code: 0 }), checkInstall: async () => ({ status: "pass" }), exitProvenance: () => ({}),
    record: (_app: unknown, _engine: string, _host: string, _stage: string, _args: string[], result: unknown) => result,
    execute,
  });
  runInContext(declarations, context);
  const fixture = fullstackApps.find(app => app.id === "fullstack-solidstart");
  assert.ok(fixture);
  context.app = fixture;
  return {
    prepare(name: string): unknown { context.name = name; return runInContext("prepare(app, name)", context); },
    command(project: unknown): string[] {
      context.project = project;
      const value: unknown = runInContext("guestCommand('quickjs', project, ['run', 'probe.ts'])", context);
      assert.ok(Array.isArray(value) && value.every(item => typeof item === "string"));
      return value;
    },
    failPreparation() { context.app = { ...fixture, files: { "invalid\0file": "invalid test path" } }; return runInContext("prepare(app, 'bad-case')", context); },
    run(): Promise<void> { return runInContext("nativeApp(app, 'quickjs')", context); },
  };
}

function project(value: unknown): { root: string; path: string } {
  assert.ok(value && typeof value === "object", "Expected an owned namespace root and app directory");
  const root: unknown = Reflect.get(value, "root");
  const path: unknown = Reflect.get(value, "path");
  assert.equal(typeof root, "string");
  assert.equal(typeof path, "string");
  if (typeof root !== "string" || typeof path !== "string") throw new Error("Invalid project namespace");
  return { root, path };
}

function mounts(argv: readonly string[]): Map<string, string> {
  const dirs = new Map<string, string>();
  for (let index = 0; index < argv.indexOf("--"); index++) {
    if (argv[index] !== "--dir") continue;
    const spec = argv[++index];
    assert.ok(spec);
    const [host, virtual] = spec.split("::");
    assert.ok(host && virtual);
    dirs.set(virtual, host);
  }
  return dirs;
}

test("native preparation creates a coherent private root containing the original app", () => ownedScratch(async scratch => {
  const run = runner(scratch);
  const value = run.prepare("solidstart-quickjs");
  expect(existsSync(join(scratch, "solidstart-quickjs", "app", "app.config.ts"))).toBe(true);
  const prepared = project(value);
  expect(prepared).toEqual({ root: join(scratch, "solidstart-quickjs"), path: join(scratch, "solidstart-quickjs", "app") });
  const namespace = mounts(run.command(value));
  expect(namespace.get("/")).toBe(prepared.root);
  expect(namespace.get("/app")).toBe(prepared.path);
  expect(Array.from(namespace.values())).toEqual([prepared.root, prepared.path]);
  expect(statSync(prepared.root).isDirectory()).toBe(true);
  expect(readdirSync(prepared.root)).toEqual(["app"]);
  const fixture = fullstackApps.find(app => app.id === "fullstack-solidstart");
  const config = fixture?.files["app.config.ts"];
  assert.ok(config);
  expect(readFileSync(join(prepared.path, "app.config.ts"), "utf8")).toBe(config);
}));

test("native cases own disjoint writable tmp/cache and cannot mount each other's files", () => ownedScratch(async scratch => {
  const run = runner(scratch);
  const firstValue = run.prepare("case-a");
  const secondValue = run.prepare("case-b");
  const first = project(firstValue);
  const second = project(secondValue);
  expect(first.root).not.toBe(second.root);
  for (const path of ["tmp", ".cache"]) {
    writeFileSync(join(first.path, path, "owned"), "case-a");
    writeFileSync(join(second.path, path, "owned"), "case-b");
    expect(readFileSync(join(first.path, path, "owned"), "utf8")).toBe("case-a");
    expect(readFileSync(join(second.path, path, "owned"), "utf8")).toBe("case-b");
  }
  expect(Array.from(mounts(run.command(firstValue)).values()).every(path => path === first.root || path === first.path)).toBe(true);
  expect(Array.from(mounts(run.command(secondValue)).values()).every(path => path === second.root || path === second.path)).toBe(true);
  rmSync(first.root, { recursive: true });
  expect(existsSync(first.root)).toBe(false);
  expect(existsSync(second.path)).toBe(true);
}));

test("a failed native stage removes only its owned case root", () => ownedScratch(async scratch => {
  const failure = new Error("forced native stage failure");
  const run = runner(scratch, async () => { throw failure; });
  run.prepare("unrelated-case");
  await expect(run.run()).rejects.toBe(failure);
  expect(existsSync(join(scratch, "fullstack-solidstart-quickjs"))).toBe(false);
  expect(existsSync(join(scratch, "unrelated-case"))).toBe(true);
}));

test("successful native stages remove only their owned case root", () => ownedScratch(async scratch => {
  const run = runner(scratch);
  run.prepare("unrelated-case");
  await run.run();
  expect(existsSync(join(scratch, "fullstack-solidstart-quickjs"))).toBe(false);
  expect(existsSync(join(scratch, "unrelated-case"))).toBe(true);
}));

test("failed fixture preparation removes its root but preserves a pre-existing case", () => ownedScratch(async scratch => {
  const run = runner(scratch);
  run.prepare("unrelated-case");
  expect(() => run.failPreparation()).toThrow();
  expect(existsSync(join(scratch, "bad-case"))).toBe(false);
  expect(existsSync(join(scratch, "unrelated-case"))).toBe(true);
}));

test("native preparation refuses to replace or remove an existing private case", () => ownedScratch(async scratch => {
  const run = runner(scratch);
  run.prepare("existing-case");
  writeFileSync(join(scratch, "existing-case", "sentinel"), "preserve");
  expect(() => run.prepare("existing-case")).toThrow();
  expect(readFileSync(join(scratch, "existing-case", "sentinel"), "utf8")).toBe("preserve");
}));

test("distinct native case roots retain distinct screenshot artifact prefixes", async () => {
  const source = readFileSync(new URL("./browser.mjs", import.meta.url), "utf8");
  const check = source.match(/^  async function checkPage\([\s\S]*?^  }/m)?.[0];
  assert.ok(check);
  const screenshots: string[] = [];
  const page = { on() {}, context: () => ({}), screenshot: async ({ path }: { path: string }) => { screenshots.push(path); } };
  const context = {
    basename, dirname, join, options: { timeout: 100, output: "/reports" },
    getBrowser: async () => ({ newPage: async () => page }), browserDiagnostics: () => () => ({}), closeContext: async () => {},
    checkNativePage: async (_page: unknown, _url: string, _check: unknown, _project: string, _timeout: number, capture: () => Promise<void>) => { await capture(); return { status: "pass" }; },
  };
  for (const name of ["case-a", "case-b"]) await runInNewContext(`(${check})('http://unused', {}, '/private/${name}/app')`, context);
  expect(screenshots).toEqual(["/reports/case-a-dev.png", "/reports/case-b-dev.png"]);
});
