import { expect, test } from "bun:test";
import { toolApps } from "./product-tools.ts";

function tool(id: string) {
  const app = toolApps.find(app => app.id === id);
  if (!app) throw new Error(`Missing product tool ${id}`);
  return app;
}

const executables: Record<string, string> = {
  vitest: "node_modules/vitest/vitest.mjs",
  prisma: "node_modules/prisma/build/index.js",
  drizzle: "node_modules/drizzle-kit/bin.cjs",
  typescript: "node_modules/typescript/bin/tsc",
  eslint: "node_modules/eslint/bin/eslint.js",
};

test("five tool fixtures invoke the installed package CLI and pin exact releases", () => {
  expect(toolApps.map(app => app.id)).toEqual(["vitest", "prisma", "drizzle", "typescript", "eslint"]);
  for (const app of toolApps) {
    expect(app.commands.some(command => command.args.includes(executables[app.id] ?? "missing CLI"))).toBe(true);
    expect(Object.values(app.dependencies).every(version => /^\d+\.\d+\.\d+$/.test(version))).toBe(true);
    expect(app.commands.some(command => command.name === "reject")).toBe(true);
  }
});

test.each(toolApps)("$id has no shadow package CLI or authored JavaScript", app => {
  expect(Object.keys(app.files).some(path => path.startsWith("node_modules/") || /\.[cm]?jsx?$/.test(path))).toBe(false);
  const names = new Set(app.commands.map(command => command.name));
  expect(names.size).toBe(app.commands.length);
  for (const command of app.commands) {
    if (!command.after) continue;
    expect(names.has(command.after)).toBe(true);
    expect(app.commands.findIndex(candidate => candidate.name === command.after)).toBeLessThan(app.commands.indexOf(command));
  }
});

test("Vitest separates passing tests from the deliberate assertion failure", () => {
  const app = tool("vitest");
  expect(app.files["tests/cart.test.ts"]).toContain("from '../src/cart'");
  expect(app.files["tests/cart.test.ts"]).toContain("toThrow('negative price')");
  expect(app.files["controls/failure.test.ts"]).toContain("toBe(99)");
  const command = app.commands.find(command => command.name === "test");
  const reject = app.commands.find(command => command.name === "reject");
  expect(command?.args).toContain("tests/cart.test.ts");
  expect(command?.args).not.toContain("controls/failure.test.ts");
  expect(reject?.args).toContain("controls/failure.test.ts");
  expect(reject?.check).toMatchObject({ kind: "diagnostics", exit: 1, texts: ["product rejection control", "AssertionError", "1 failed"] });
});

test("Prisma generates its real client, creates a local SQLite schema, and rejects unique writes", () => {
  const app = tool("prisma");
  expect(app.files["prisma/schema.prisma"]).toContain('provider = "sqlite"');
  expect(app.files["prisma/schema.prisma"]).toContain('url = "file:./product.db"');
  expect(app.files["prisma/schema.prisma"]).toContain("key String @unique");
  expect(app.commands.find(command => command.name === "generate")?.check).toMatchObject({ kind: "files", paths: ["node_modules/.prisma/client/index.js", "node_modules/.prisma/client/schema.prisma"], text: "Message" });
  expect(app.commands.find(command => command.name === "schema")?.args).toContain("push");
  expect(app.commands.find(command => command.name === "query")?.after).toBe("schema");
  expect(app.commands.find(command => command.name === "reject-schema")?.check).toMatchObject({ kind: "diagnostics", exit: 1 });
  expect(app.files["reject.ts"]).toContain("Prisma.PrismaClientKnownRequestError");
  expect(app.files["reject.ts"]).toContain("'P2002'");
  expect(app.files["reject.ts"]).toContain("if (!rejected)");
  expect(app.files["reject.ts"]).toContain("count !== 1");
});

test("Drizzle applies Kit-generated SQL to real bun:sqlite before query and rejection controls", () => {
  const app = tool("drizzle");
  expect(app.commands.find(command => command.name === "generate")?.args).toContain("--name=product");
  expect(app.commands.find(command => command.name === "generate")?.check).toMatchObject({ kind: "files", paths: ["drizzle/0000_product.sql"], text: "CREATE TABLE" });
  expect(app.files["migrate.ts"]).toContain("drizzle-orm/bun-sqlite/migrator");
  expect(app.files["migrate.ts"]).toContain("migrate(db, { migrationsFolder: './drizzle' })");
  expect(app.files["migrate.ts"]).toContain("sqlite_master");
  expect(app.files["query.ts"]).toContain("new Database('product.db')");
  expect(app.files["query.ts"]).toContain("from 'drizzle-orm/bun-sqlite'");
  expect(app.files["reject.ts"]).toContain("UNIQUE constraint failed");
  expect(app.files["reject.ts"]).toContain("if (!rejected)");
  expect(app.files["reject.ts"]).toContain("rows.length !== 1");
});

test("TypeScript checks without emitting, builds both modules, and executes the emitted import", () => {
  const app = tool("typescript");
  expect(app.commands.find(command => command.name === "check")?.args).toContain("--noEmit");
  expect(app.commands.find(command => command.name === "reject")?.check).toMatchObject({ kind: "diagnostics", exit: 2, texts: ["error TS2322", "Type 'number' is not assignable to type 'string'"] });
  expect(app.commands.find(command => command.name === "build")?.check).toMatchObject({ kind: "files", paths: ["dist/index.js", "dist/message.js"] });
  expect(app.commands.find(command => command.name === "run")).toMatchObject({ after: "build", args: ["run", "dist/index.js"] });
  expect(app.files["src/index.ts"]).toContain("from './message.js'");
});

test("ESLint uses the TypeScript parser with an active rule and verifies failing diagnostics", () => {
  const app = tool("eslint");
  expect(app.dependencies["@typescript-eslint/parser"]).toBe("8.46.1");
  expect(app.dependencies.jiti).toBe("2.6.1");
  expect(app.files["eslint.config.ts"]).toContain("from '@typescript-eslint/parser'");
  expect(app.files["eslint.config.ts"]).toContain("'no-debugger': 'error'");
  expect(app.files["controls/invalid.ts"]).toContain("debugger;");
  expect(app.commands.find(command => command.name === "reject")?.check).toMatchObject({ kind: "diagnostics", exit: 1 });
});

test.each(toolApps)("$id source fixtures parse as TypeScript", app => {
  for (const [path, source] of Object.entries(app.files)) {
    if (!path.endsWith(".ts")) continue;
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(source)).not.toThrow();
  }
});
