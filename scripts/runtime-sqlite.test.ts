import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-runtime-sqlite-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const source = join(root, "crates/bunwasm-runtime/src/js/bun_sqlite.ts");
const probe = join(scratch, "probe.ts");
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(root, "crates/bunwasm-runtime/tsconfig.json"), include: [],
  files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), join(root, "crates/bunwasm-runtime/src/js/sqlite_types.d.ts"), probe],
}));
const native = `declare const native: BunWasm.SQLiteNative;
const connection = native.open(":memory:", 6);
const statement = native.prepare(connection, "select 1", 0, false);
`;

function check(text: string) {
  writeFileSync(probe, text);
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

function wrapper(text: string) {
  return `const install = ${readFileSync(source, "utf8")}\ndeclare const internal: BunWasm.Internal;\nconst db = new (install(internal).Database)();\n${text}`;
}

test("SQLite preserves each emitted runtime token's TypeScript source position", () => {
  const output = join(scratch, "sqlite.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), source, output]);
  expect(result.exitCode).toBe(0);
  const original = readFileSync(source, "utf8").split("\n");
  const emitted = readFileSync(output, "utf8");
  const parsed = ts.createSourceFile("sqlite.js", emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  expect(emitted.split("\n").length).toBe(original.length);
  function visit(node: ts.Node) {
    const children = node.getChildren(parsed);
    if (children.length) return children.forEach(visit);
    const start = node.getStart(parsed);
    const { line, character } = parsed.getLineAndCharacterOfPosition(start);
    expect(original[line]?.slice(character, character + node.getWidth(parsed))).toBe(node.getText(parsed));
  }
  visit(parsed);
});

test("SQLite native modes and safe row IDs have their actual distinct result types", () => {
  const result = check(native + `
const first: BunWasm.SQLiteRow | null = native.rows(statement, undefined, 0, false);
const all: BunWasm.SQLiteRow[] = native.rows(statement, [], 1, true);
const values: BunWasm.SQLiteValue[][] | null = native.rows(statement, [], 2, false);
const raw: (Uint8Array | null)[][] | null = native.rows(statement, [], 3, true);
const next: BunWasm.SQLiteRow | null = native.next(statement, undefined, false, true);
const unsafeId: number = native.run(statement, undefined, false)[1];
const safeId: bigint = native.run(statement, [], true)[1];
declare const safe: boolean;
const dynamicId: number | bigint = native.exec(connection, "select 1", null, safe)[1];
const names: (string | null)[] | null = native.firstParamNames(connection, "-- empty");
const declared: (string | null)[] = native.declaredTypes(statement);
native.bind(statement, [null, true, 1, 1n, "text", new Uint8Array()]);
native.close(native.deserialize(new DataView(new ArrayBuffer(1)), false), true);
`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const rejected = [
  'native.rows(connection, undefined, 0, false);',
  'native.close(statement, true);',
  'native.rows(statement, [], 4, false);',
  'native.rows(statement, [], 0);',
  'native.bind(statement, [new Date()]);',
  'native.prepare(connection, "select 1", 0, "owned");',
  'const value: number = native.run(statement, [], true)[1];',
  'const value: bigint = native.run(statement, [], false)[1];',
  'const value: BunWasm.SQLiteRow[] = native.rows(statement, [], 0, false);',
  'const value: BunWasm.SQLiteValue[][] = native.rows(statement, [], 2, false);',
  'const value: Uint8Array[][] = native.rows(statement, [], 3, false);',
  'const value: string[] = native.firstParamNames(connection, "-- empty");',
  'const value: number = native.rows(statement, [], 0, false)?.value;',
];
for (const text of rejected) {
  test(`SQLite rejects a false native contract: ${text}`, () => {
    const result = check(native + text);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

test("SQLite transactions keep the callback's arguments, receiver, result and recursive variants", () => {
  const result = check(wrapper(`
const transaction = db.transaction(function(this: { prefix: string }, value: number) { return this.prefix + value; });
const output: string = transaction.exclusive.deferred.call({ prefix: "n=" }, 1);
const sameDatabase: typeof db = transaction.database;
class Row {}
db.query("select 1").as(Row);
const dynamicRow: BunWasm.SQLiteRow | null = db.query("select 1").get();
const values: BunWasm.SQLiteValue[][] | null = db.query("select 1").values();
`));
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

for (const text of [
  'db.transaction((value: number) => value).immediate("wrong");',
  'const value: number = db.transaction(() => "text")();',
  'db.query("select 1").as({ prototype: {} });',
  'const value: { id: number } = db.query("select 1 as id").get();',
]) {
  test(`SQLite rejects a false wrapper contract: ${text}`, () => {
    const result = check(wrapper(text));
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
