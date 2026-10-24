import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript-api";
import { constructorControl, keyControl } from "./runtime-util-controls";
import { astHash, constructorCode, keysCode, restoreDestinations } from "./runtime-util-equivalence";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-assert-util-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const runtime = join(root, "crates/bunwasm-runtime/src/js");

// Original JavaScript at ac43127. Reverse only the two authorized destination extractions and redundant parentheses.
const originals = {
  assert: "381972f164ac6fd3b776919ccde896d8dd8c20e4758b29d2d500234ee5b291db",
  util: "72229e61f5716247725a2c3caf6c861a28e1f659fa3ed509f21e41113e428bcf",
};

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
    expect(astHash(name === "util" ? restoreDestinations(emitted.text) : emitted.text)).toBe(hash);
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
const positional: BunWasm.ParseToken = { kind: "positional", index: 0, value: true };
const rawOption: BunWasm.ParseToken = { kind: "option", name: {}, rawName: 1, index: 0, value: true, inlineValue: false };
const result = internal.require("util").parseArgs({ args: [1, true, {}], tokens: true });
const raw: unknown = result.positionals[0];
if (typeof raw === "string") raw.toUpperCase();
const optionValue: unknown = result.values.file;
if (typeof optionValue === "boolean") optionValue.valueOf();
for (const item of result.tokens ?? []) {
  if (item.kind !== "option") continue;
  if (typeof item.name === "string") item.name.toUpperCase();
  if (typeof item.rawName === "string") item.rawName.toUpperCase();
  if (typeof item.value === "string") item.value.toUpperCase();
}
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
  'const token: BunWasm.ParseToken = { kind: "positional", index: "0", value: true };',
  'internal.require("util").parseArgs({}).positionals[0].toUpperCase();',
  'internal.require("util").parseArgs({}).values.file.toUpperCase();',
  'declare const token: BunWasm.OptionToken; token.value.toUpperCase();',
  'declare const token: BunWasm.OptionToken; token.name.toUpperCase();',
  'declare const token: BunWasm.OptionToken; token.rawName.toUpperCase();',
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

function emittedUtil(): string {
  const path = join(scratch, "util-controls.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(runtime, "util.ts"), path]);
  expect(result.exitCode).toBe(0);
  return readFileSync(path, "utf8");
}

test("Node verifies raw parser contracts and destination order with every observed fault", () => {
  emittedUtil();
  const result = Bun.spawnSync(["node", join(root, "scripts/runtime-util-controls.ts"), join(scratch, "util-controls.js"), join(scratch, "controls.json")]);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("PASS original and corrected");
  expect(result.exitCode).toBe(0);
});

function preservesOriginal(text: string): boolean {
  try { return astHash(restoreDestinations(text)) === originals.util; }
  catch { return false; }
}

test("AST allowance rejects reordered destinations, changed arrays and changes elsewhere", () => {
  const text = emittedUtil();
  const capture = "const ConstructorSet = Set;";
  const arrayStart = text.indexOf("const constructors");
  const arrayEnd = text.indexOf(";", arrayStart) + 1;
  const late = text.replace(capture, "").replace(text.slice(arrayStart, arrayEnd), text.slice(arrayStart, arrayEnd) + capture);
  expect(preservesOriginal(text)).toBe(true);
  expect(preservesOriginal(late)).toBe(false);
  expect(preservesOriginal(text.replace(capture, "").replace("  function sameConstructorOrPrototype(", capture + "\n  function sameConstructorOrPrototype("))).toBe(false);
  expect(preservesOriginal(text.replace("[Object, Array, Function", "[Array, Object, Function"))).toBe(false);
  expect(preservesOriginal(text.replace('arg === "--"', 'arg === "-"'))).toBe(false);
  expect(preservesOriginal(text.replace("Object.keys(obj);", "Object.keys(obj); void obj;"))).toBe(false);
});

test("executable controls detect Set lookup and string/Symbol/concat reordering", () => {
  const text = emittedUtil();
  const original = restoreDestinations(text);
  const code = constructorCode(text, true);
  const captureEnd = code.indexOf(";") + 1;
  const arrayEnd = code.indexOf(";", captureEnd) + 1;
  const late = code.slice(captureEnd, arrayEnd) + code.slice(0, captureEnd) + code.slice(arrayEnd);
  expect(constructorControl(code)).toEqual(constructorControl(constructorCode(original, false)));
  expect(constructorControl(late)).not.toEqual(constructorControl(constructorCode(original, false)));
  const keys = keysCode(text);
  const reordered = keys.replace(/const keys[^;]+;/, "const symbols = enumerableSymbols(obj); const keys = Object.keys(obj);").replace("keys.concat(enumerableSymbols(obj))", "keys.concat(symbols)");
  expect(keyControl(keys)).toEqual(keyControl(keysCode(original)));
  expect(keyControl(reordered)).not.toEqual(keyControl(keysCode(original)));
});

test("raw-operation assertions match the per-use parser manifest", () => {
  const text = readFileSync(join(runtime, "util.ts"), "utf8");
  const source = ts.createSourceFile("util.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const actual: { line: number; expression: string; view: string }[] = [];
  const start = text.indexOf("  function objectGetOwn(");
  const end = text.indexOf("  // Legacy helpers", start);
  function visit(node: ts.Node): void {
    if (ts.isAsExpression(node) && node.getStart(source) >= start && node.end < end) actual.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression: node.expression.getText(source), view: node.type.getText(source) });
    ts.forEachChild(node, visit);
  }
  visit(source);
  const manifest: { operations: { line: number; expression: string; view: string; classification: string }[] } = JSON.parse(readFileSync(join(root, "docs/runtime-util-raw-operations.json"), "utf8"));
  expect(actual).toEqual(manifest.operations.map(({ line, expression, view }) => ({ line, expression, view })));
  expect(manifest.operations.every(operation => operation.classification.length > 0)).toBe(true);
});

test("raw parser controls reject added validation or positional coercion", () => {
  const text = emittedUtil();
  const mutants = [
    text.replace("const arg = remaining.shift();", 'const arg = remaining.shift(); if (typeof arg !== "string") throw new TypeError("new validation");'),
    text.replace("value: arg", "value: String(arg)"),
  ];
  for (const [index, mutant] of mutants.entries()) {
    expect(mutant).not.toBe(text);
    const path = join(scratch, `mutant-${index}.js`);
    writeFileSync(path, mutant);
    const result = Bun.spawnSync(["node", join(root, "scripts/runtime-util-controls.ts"), path, join(scratch, `mutant-${index}.json`)]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(index === 0 ? "TypeError: new validation" : "AssertionError");
    expect(result.stdout.toString()).not.toContain("PASS original and corrected");
  }
});
