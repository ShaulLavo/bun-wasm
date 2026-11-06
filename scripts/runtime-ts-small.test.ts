import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeSyntax } from "./runtime-syntax";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ts-small-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Pin the original ASTs at e0c85f29, and SQLite at ac43127c. Ignore only redundant expression parentheses.
// Formats and SQLite separately permit only their explicit guard and iterator cleanup deltas.
const originals = {
  cookie: "5cc1305618ad7b836b36694847306b57aa21a4a6d8bd977ffd3e5901cc21b34f",
};

for (const [name, hash] of Object.entries(originals)) {
  test(`${name} embeds the original runtime syntax, including strict directives`, () => {
    const output = join(scratch, `${name}.js`);
    const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output]);
    expect(result.exitCode).toBe(0);
    const emitted = readFileSync(output, "utf8");
    expect(createHash("sha256").update(runtimeSyntax(emitted)).digest("hex")).toBe(hash);
  });
}

const originalSQLite = "b16a65d13a67fecf1c3f847afcdc26bc3430762ddb75653244bf3820ebebb6e0";

function sqliteSource() {
  const output = join(scratch, "sqlite-delta.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js/bun_sqlite.ts"), output]);
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

function sqliteIterators(node: ts.Node, methods: ts.MethodDeclaration[]) {
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "iterate") methods.push(node);
  ts.forEachChild(node, child => sqliteIterators(child, methods));
}

function restoreSQLiteIteration(source: string) {
  const parsed = ts.createSourceFile("sqlite.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const methods: ts.MethodDeclaration[] = [];
  sqliteIterators(parsed, methods);
  const method = methods[0];
  if (methods.length !== 1 || !method?.body || method.body.statements.length !== 2) throw new Error("Expected one SQLite iterator cleanup delta");
  const cleanup = method.body.statements[1];
  if (!cleanup || !ts.isTryStatement(cleanup) || cleanup.catchClause || !cleanup.finallyBlock) throw new Error("Expected one SQLite iterator cleanup delta");
  const loop = cleanup.tryBlock.statements[0];
  if (cleanup.tryBlock.statements.length !== 1 || !loop || !ts.isForStatement(loop)) throw new Error("Expected one SQLite iterator loop");
  const finalizer = cleanup.finallyBlock.statements[0];
  if (cleanup.finallyBlock.statements.length !== 1 || !finalizer || runtimeSyntax(finalizer.getText(parsed)) !== runtimeSyntax("sql.reset(this.#id);")) throw new Error("Expected exactly one SQLite reset finalizer");
  const restored = source.slice(0, cleanup.getStart(parsed)) + loop.getText(parsed) + source.slice(cleanup.end);
  return createHash("sha256").update(runtimeSyntax(restored)).digest("hex");
}

test("SQLite differs from the original AST only by iterator finally cleanup", () => {
  const emitted = sqliteSource();
  expect(createHash("sha256").update(runtimeSyntax(emitted)).digest("hex")).not.toBe(originalSQLite);
  expect(restoreSQLiteIteration(emitted)).toBe(originalSQLite);
});

for (const replacement of [";", "sql.reset(this.#id); sql.reset(this.#id);", "sql.finalize(this.#id);"]) {
  test(`SQLite delta proof rejects missing, duplicate or unexpected cleanup: ${replacement}`, () => {
    const emitted = sqliteSource();
    const changed = emitted.replace("sql.reset(this.#id);", replacement);
    expect(changed).not.toBe(emitted);
    expect(() => restoreSQLiteIteration(changed)).toThrow("Expected exactly one SQLite reset finalizer");
  });
}

test("SQLite delta proof detects changed iteration and unrelated runtime behavior", () => {
  const emitted = sqliteSource();
  const changedLoop = emitted.replace("yield this.#shape(row);", "yield row;");
  const changedElsewhere = emitted.replace("Expected array", "changed binding error");
  expect(changedLoop).not.toBe(emitted);
  expect(changedElsewhere).not.toBe(emitted);
  expect(restoreSQLiteIteration(changedLoop)).not.toBe(originalSQLite);
  expect(restoreSQLiteIteration(changedElsewhere)).not.toBe(originalSQLite);
});

const originalFormats = "2e6b5465d602987a9a0a5a455d7ced74ab893db48fc4617cb23cd89d24bae930";

function formatsSource() {
  const output = join(scratch, "formats.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js/formats.ts"), output]);
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

function restoreFormatsGuard(source: string) {
  const changes: [RegExp, string][] = [
    [/const \{ checkSize \} = internal\.require\("formats_limit"\);/g, ""],
    [/let bytes\s*;/g, ""],
    [/bytes = textBytes\(input, true\)/g, "input = textBytes(input, true)"],
    [/bytes = input\._bytes\(\)/g, "input = input._bytes()"],
    [/bytes = internal\.toUint8\(input\)/g, "input = internal.toUint8(input)"],
    [/bytes = textBytes\(input, false\)/g, "input = textBytes(input, false)"],
    [/checkSize\(bytes\);/g, 'if (input.byteLength > 0x7fffffff) throw new RangeError("input.byteLength must be <= 2147483647");'],
    [/native\.parseData\(bytes, format\)/g, "native.parseData(input, format)"],
  ];
  for (const [pattern, original] of changes) {
    if (Array.from(source.matchAll(pattern)).length !== 1) throw new Error(`Expected one guard delta: ${pattern}`);
    source = source.replace(pattern, original);
  }
  return createHash("sha256").update(runtimeSyntax(source)).digest("hex");
}

test("formats differs from the original AST only by the explicit input-limit guard delta", () => {
  const emitted = formatsSource();
  expect(createHash("sha256").update(runtimeSyntax(emitted)).digest("hex")).not.toBe(originalFormats);
  expect(restoreFormatsGuard(emitted)).toBe(originalFormats);
});

test("formats delta proof rejects a missing guard or changed conversion", () => {
  const emitted = formatsSource();
  expect(() => restoreFormatsGuard(emitted.replace("checkSize(bytes);", ";"))).toThrow("Expected one guard delta");
  expect(() => restoreFormatsGuard(emitted.replace("bytes = textBytes(input, true)", "bytes = textBytes(input, false)"))).toThrow("Expected one guard delta");
});

test("formats delta proof still detects unrelated serialization changes", () => {
  const emitted = formatsSource();
  const changed = emitted.replace("Converting circular structure to JSON5", "changed error");
  expect(changed).not.toBe(emitted);
  expect(restoreFormatsGuard(changed)).not.toBe(originalFormats);
});

test("SQLite preserves each emitted runtime token's TypeScript source position", () => {
  const source = join(root, "crates/bunwasm-runtime/src/js/bun_sqlite.ts");
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
