import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-assert-util-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const runtime = join(root, "crates/bunwasm-runtime/src/js");

// Original JavaScript at ac43127. Ignore only redundant expression parentheses.
const originals = {
  assert: "381972f164ac6fd3b776919ccde896d8dd8c20e4758b29d2d500234ee5b291db",
  util: "72229e61f5716247725a2c3caf6c861a28e1f659fa3ed509f21e41113e428bcf",
};

function syntax(source: ts.SourceFile): string {
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(source);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(source)];
  }
  return JSON.stringify(visit(source));
}

function checkPositions(source: string, emitted: ts.SourceFile): number {
  const lines = source.split("\n");
  expect(emitted.text.split("\n").length).toBe(lines.length);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  let count = 0;
  function visit(node: ts.Node): void {
    const children = node.getChildren(emitted);
    if (children.length) return children.forEach(visit);
    const { line, character } = emitted.getLineAndCharacterOfPosition(node.getStart(emitted));
    const text = node.getText(emitted);
    const start = offsets[line];
    if (start === undefined) throw new Error(`Missing TypeScript line ${line + 1}`);
    expect(source.slice(start + character, start + character + text.length)).toBe(text);
    count++;
  }
  visit(emitted);
  return count;
}

for (const [name, hash] of Object.entries(originals)) {
  test(`${name} preserves its original AST, strict directive, and runtime token positions`, () => {
    const path = join(runtime, `${name}.ts`);
    const output = join(scratch, `${name}.js`);
    const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), path, output]);
    expect(result.exitCode).toBe(0);
    const emitted = ts.createSourceFile(`${name}.js`, readFileSync(output, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect(createHash("sha256").update(syntax(emitted)).digest("hex")).toBe(hash);
    expect(checkPositions(readFileSync(path, "utf8"), emitted)).toBeGreaterThan(1000);
  });
}

const probe = join(scratch, "probe.ts");
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
  include: [],
  files: [join(runtime, "runtime.d.ts"), join(runtime, "assert_util_types.d.ts"), probe],
}));

function check(source: string) {
  writeFileSync(probe, 'declare const internal: BunWasm.Internal;\n' + source);
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config]);
}

test("accepts inspect, equality, partial assertion, process, and parser token contracts", () => {
  const result = check(`
internal.require("inspect").nodeInspect({}, { depth: null, sorted: true, getters: "get" });
internal.require("inspect").nodeFormatWithOptions({ colors: false }, "%s", 1);
internal.require("util").bunDeepEquals(new Map(), new Map(), true);
internal.require("partial_assert").create(options => { throw options; }, (count, min) => {})(1, 2);
const token: BunWasm.ParseToken = { kind: "option", name: "file", rawName: "-f", index: 0, value: "x", inlineValue: true };
const proc: BunWasm.RuntimeProcess = { cwd: () => "/", argv: ["bun"], nextTick: (fn, ...args) => { fn(...args); } };
`);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalid = [
  'internal.require("inspect").nodeInspect({}, { depth: "deep" });',
  'internal.require("inspect").nodeFormatWithOptions({ getters: "all" }, "%s");',
  'internal.require("util").bunDeepEquals(1, 2, "strict");',
  'internal.require("partial_assert").create(() => {}, () => {});',
  'const token: BunWasm.ParseToken = { kind: "positional", index: 0, value: true };',
  'const token: BunWasm.ParseToken = { kind: "option-terminator", index: 0, value: "unexpected" };',
  'const proc: BunWasm.RuntimeProcess = { cwd: () => 1 };',
];
for (const source of invalid) {
  test(`rejects invalid assert/util contract ${source}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
