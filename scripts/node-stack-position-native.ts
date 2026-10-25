import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStackProbe, quickjsColumnProbe, quickjsLexerInputs, stackFormatter, stackSite } from "./node-stack-position-fixture";
import { newTokenLength, tokenCases, verifyRawStackSources, verifyTokenLengths } from "../tests/fixtures/stack-source-position/contract";

let scratch: string | undefined;
let probe = "";
let columnProbe = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stack-native-"));
  const source = join(scratch, "probe.rs");
  writeFileSync(source, nativeStackProbe());
  const columnSource = join(scratch, "column-probe.c");
  columnProbe = join(scratch, "column-probe");
  writeFileSync(columnSource, quickjsColumnProbe());
  const lexer = quickjsLexerInputs();
  writeFileSync(join(scratch, "quickjs-lexer-stubs.h"), lexer.stubs);
  writeFileSync(join(scratch, "quickjs-lexer.h"), lexer.lexer);
  const include = new URL("../third_party/rquickjs-sys/quickjs", import.meta.url).pathname;
  execFileSync("cc", ["-std=c11", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Werror", "-isystem", include, "-isystem", scratch, columnSource, "-o", columnProbe], { stdio: "pipe" });
  const tests = join(scratch, "tests");
  execFileSync("rustc", ["--edition=2024", "--test", source, "-o", tests], { stdio: "pipe" });
  console.log(execFileSync(tests, ["--test-threads=1", "--nocapture"], { encoding: "utf8" }));
  probe = join(scratch, "probe");
  execFileSync("rustc", ["--edition=2024", "-O", source, "-o", probe], { stdio: "pipe" });
});
afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

function offsets(cases: readonly { text: string; column: number; line?: number }[]): number[] {
  const input = cases.map(item => `${String(item.column)} ${item.line ?? 1} ${Buffer.from(item.text).toString("hex")}`).join("\n") + "\n";
  return execFileSync(probe, { input, encoding: "utf8", maxBuffer: 1024 * 1024 }).trim().split("\n").map(Number);
}

test("actual Rust State and registered native match the unchanged JS regex oracle", () => {
  const cases = tokenCases();
  const actual = offsets(cases);
  expect(actual).toEqual(cases.map(item => newTokenLength(item.text, item.column)));
  let current = 0;
  const formatter = stackFormatter({ engine: "host", mapPosition: () => undefined, sourceNewOffset: () => actual[current] });
  for (const [position, item] of cases.entries()) {
    current = position;
    const length = newTokenLength(item.text, item.column);
    expect(formatter.format(stackSite(item.column))).toBe(`caller (/huge.cjs:1:${length ? item.column + length : item.column})`);
  }
  let index = 0;
  verifyTokenLengths(() => actual[index++] ?? -1);
  expect(offsets([
    { text: "new\r\nnew\r", line: 1, column: 1 },
    { text: "new\r\nnew\r", line: 2, column: 1 },
    { text: "new Error\n", line: 2, column: 1 },
    { text: "new Error", line: 0, column: 1 },
    { text: "\nnew\u2028 Error", line: 2, column: 1 },
  ])).toEqual([0, 4, 0, 0, 5]);
});


test("production bootstrap consumes only numeric native results on huge lines", () => {
  const source = "/*😀*/new \tError();/*" + "x".repeat(4 * 1024 * 1024) + "*/";
  const result = offsets([{ text: source, column: 7 }])[0];
  expect(result).toBe(5);
  let calls = 0;
  const formatter = stackFormatter({ engine: "host", mapPosition: () => undefined, sourceNewOffset() { calls++; return result; }, getSourceLine() { throw new Error("whole line transferred"); } });
  for (let index = 0; index < 64; index++) expect(formatter.format(stackSite(7))).toBe("caller (/huge.cjs:1:12)");
  expect(calls).toBe(64);
});

test("stack fixture uses its isolated launcher root without requiring a temp parent", () => {
  assert.ok(scratch);
  const root = join(scratch, "launcher-root");
  cpSync(new URL("../tests/fixtures/stack-source-position", import.meta.url), root, { recursive: true });
  const files = readdirSync(root);
  const missing = join(scratch, "missing-temp-parent");
  expect(existsSync(missing)).toBe(false);
  const stdout = execFileSync("node", ["--no-warnings", join(root, "index.ts")], {
    cwd: root, env: { ...process.env, TMPDIR: missing }, encoding: "utf8", stdio: "pipe",
  });
  expect(stdout).toBe(readFileSync(join(root, "expected.txt"), "utf8"));
  expect(readdirSync(root)).toEqual(files);
  expect(existsSync(missing)).toBe(false);
});

function quickjsColumns(source: string, positions: readonly { line: number; token: number; reset?: boolean; parser?: 0 | 1 }[]) {
  assert.ok(scratch);
  const file = join(scratch, "column-input.js");
  writeFileSync(file, source);
  const input = positions.map(item => `${item.parser ?? 0} ${Number(item.reset ?? false)} ${item.line} ${item.token}`).join("\n") + "\n";
  return execFileSync(columnProbe, [file], { input, encoding: "utf8", timeout: 30_000 }).trim().split("\n").map(line => line.split(" ").map(Number));
}

test("QuickJS call coordinates preserve UTF-16 at all four parser owners", () => {
  const source = "/*😀𐐀*/module.exports = new\t\ufeff\u00a0Error('stack');/**/";
  const token = Buffer.byteLength(source.slice(0, source.indexOf("Error")));
  expect(quickjsColumns(source, [{ line: 0, token }])[0]?.slice(0, 4)).toEqual([32, 32, 32, 32]);
});


test("QuickJS cursor resets for parser initialization, line changes and rewinds", () => {
  const source = "a😀bé𝄞c\r\n中d\n😀z";
  const positions = [
    { line: 0, token: 8 }, { line: 0, token: 8 },
    { line: 0, token: 3 }, { line: 0, token: 8 },
    { line: 10, token: 12 }, { line: 13, token: 15 },
    { line: 10, token: 11 }, { line: 0, token: 4 },
    { line: 0, token: 8, reset: true },
    { line: 0, token: 4, parser: 1 }, { line: 0, token: 8 },
    { line: 0, token: 8, parser: 1 }, { line: 0, token: 0, reset: true },
  ] satisfies Parameters<typeof quickjsColumns>[1];
  const bytes = positions.map(item => ({ ...item, line: Buffer.byteLength(source.slice(0, item.line)), token: Buffer.byteLength(source.slice(0, item.token)) }));
  const rows = quickjsColumns(source, bytes);
  expect(rows.map(row => row.slice(0, 4))).toEqual(positions.map(item => Array.from({ length: 4 }, () => item.token - item.line + 1)));
  expect(rows[1]?.[4]).toBe(rows[0]?.[4]);
  expect(rows[10]?.[4]).toBe(rows[9]?.[4]);
});

test("QuickJS cursor counts ASCII, BMP and astral codepoint widths like JavaScript", () => {
  const characters = ["a", "\t", "\ufeff", "\u00a0", "\u0085", "\u007f", "\u07ff", "\u0800", "\ud7ff", "\ue000", "\uffff", "𐀀", "􏿿"];
  let random = 7;
  for (let index = 0; index < 256; index++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const codepoint = random % 0x110000;
    if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
    characters.push(String.fromCodePoint(codepoint));
  }
  const source = characters.join("");
  let token = 0;
  const positions = characters.map(character => { const position = { line: 0, token }; token += Buffer.byteLength(character); return position; });
  let column = 1;
  const expected = characters.map(character => { const value = Array.from({ length: 4 }, () => column); column += character.length; return value; });
  expect(quickjsColumns(source, positions).map(row => row.slice(0, 4))).toEqual(expected);
  const ascii = "identifier();".repeat(256);
  const asciiPositions = Array.from({ length: ascii.length + 1 }, (_, token) => ({ line: 0, token }));
  expect(quickjsColumns(ascii, asciiPositions).map(row => row.slice(0, 4))).toEqual(asciiPositions.map(item => Array.from({ length: 4 }, () => item.token + 1)));
});

test("QuickJS monotonic minified call columns scan each requested prefix byte once", () => {
  const prefix = "/*" + "😀中é".repeat(128 * 1024) + "*/";
  const call = "f();/*😀é*/";
  const count = 1024;
  const source = prefix + call.repeat(count) + "/*" + "x".repeat(4 * 1024 * 1024) + "*/";
  const prefixBytes = Buffer.byteLength(prefix);
  const callBytes = Buffer.byteLength(call);
  const positions = Array.from({ length: count }, (_, index) => ({ line: 0, token: prefixBytes + index * callBytes }));
  const rows = quickjsColumns(source, positions);
  expect(rows.map(row => row.slice(0, 4))).toEqual(positions.map((_, index) => Array.from({ length: 4 }, () => prefix.length + index * call.length + 1)));
  const scanned = rows.at(-1)?.[4];
  expect(scanned).toBe(prefixBytes + (count - 1) * callBytes);
  console.log(JSON.stringify({ parserCallQueries: count * 4, sourceBytes: Buffer.byteLength(source), scannedBytes: scanned, unusedTailBytes: Buffer.byteLength(source) - (scanned ?? 0) }));
});


test("QuickJS cursor resets across every ECMAScript line separator", () => {
  const separators = ["\n", "\r\n", "\r", "\u2028", "\u2029"];
  const text = "é😀x";
  const source = separators.map(separator => text + separator).join("") + text;
  let line = 0;
  const positions = separators.map(separator => {
    const position = { line, token: line + Buffer.byteLength(text) };
    line += Buffer.byteLength(text + separator);
    return position;
  }).concat([{ line, token: line + Buffer.byteLength(text) }, { line: 0, token: Buffer.byteLength(text) }]);
  expect(quickjsColumns(source, positions).map(row => row.slice(0, 4))).toEqual(positions.map(() => [5, 5, 5, 5]));
});

function lexerRows(source: string, mode = "lexer", saveIndex = 0) {
  assert.ok(scratch);
  const path = join(scratch, "lexer-input.js");
  writeFileSync(path, source);
  const output = execFileSync(columnProbe, [path, mode, String(saveIndex)], { encoding: "utf8", timeout: 30_000 });
  return output.trim().split("\n").map(row => ({
    rewound: row.startsWith("rewound "),
    values: row.replace(/^rewound /, "").split(" ").map(Number),
  }));
}

function multilineSources() {
  const prefixes = ["/*😀*/", "void /*😀中é*/"];
  const literals = ["'x\\\ny'", "'x\\\r\ny'", "'x\\\ry'", "`x\ny`", "`x\r\ny`", "`x\ry`"];
  return prefixes.flatMap(prefix => literals.map(literal => ({ source: prefix + literal + "();", saveIndex: Number(prefix.startsWith("void")) })));
}

function verifyLexerColumns(source: string, rows: ReturnType<typeof lexerRows>) {
  const bytes = Buffer.from(source);
  for (const row of rows) {
    const [token, , origin, , column] = row.values;
    assert.ok(token !== undefined && origin !== undefined);
    expect(origin).toBeLessThanOrEqual(token);
    expect(column).toBe(bytes.subarray(origin, token).toString("utf8").length + 1);
  }
}

test("actual QuickJS lexer retains selected-token origins across multiline literals", () => {
  for (const item of multilineSources()) {
    const rows = lexerRows(item.source);
    const selected = rows[item.saveIndex]?.values;
    expect(selected?.[1]).toBe(1);
    expect(selected?.[2]).toBe(0);
    expect(selected?.[3]).toBeGreaterThan(selected?.[0] ?? Infinity);
    verifyLexerColumns(item.source, rows);
  }
});

test("actual QuickJS get-position and repeated seeks preserve multiline token origins", () => {
  for (const item of multilineSources()) {
    const baseline = lexerRows(item.source).slice(item.saveIndex).map(row => row.values.filter((_, index) => index !== 5));
    const rows = lexerRows(item.source, "seek", item.saveIndex);
    expect(rows.filter(row => row.rewound)).toHaveLength(3);
    expect(rows.slice(item.saveIndex).map(row => row.values.filter((_, index) => index !== 5))).toEqual(baseline.concat(baseline, baseline, baseline));
    verifyLexerColumns(item.source, rows);
  }
});

test("actual QuickJS lexer preserves ordinary Unicode lines, regex and template-resume positions", () => {
  const cases = ["/*é😀*/Error('x');\r\n/*中*/Error('y');", "/*😀*/ /é😀/.test('x'); Error('y');", "/*😀*/`x\n${Error('x')}y`;", "/*😀*/\u2028Error('x');\u2029Error('y');"];
  for (const source of cases) verifyLexerColumns(source, lexerRows(source));
});

test("actual QuickJS tokenization bounds monotonic call-column work on a huge line", () => {
  const prefix = "/*" + "😀中é".repeat(128 * 1024) + "*/";
  const calls = "Error('x');".repeat(1024);
  const source = prefix + calls + "/*" + "x".repeat(1024 * 1024) + "*/";
  expect(lexerRows(source, "volume")[0]?.values).toEqual([5120, Buffer.byteLength(prefix + calls) - 1]);
});


test("actual QuickJS lexer keeps errors on the current line after multiline tokens", () => {
  expect(lexerRows("/*😀*/'x\\\ny'; 'bad\n", "error")[0]?.values).toEqual([-1, 2]);
  expect(lexerRows("/*😀*/`x\ny`; /*unterminated", "error")[0]?.values).toEqual([-1, 2]);
});

function rawFixtureObserverProbe(): string {
  const source = readFileSync(new URL("../tests/fixtures/stack-source-position/index.ts", import.meta.url), "utf8");
  const helper = source.indexOf("function rawModulePosition(");
  const start = helper < 0 ? source.indexOf("function loadObserved(") : helper;
  const end = source.indexOf("\ntry {", start);
  assert.ok(start > 0 && end > start);
  return [
    'import assert from "node:assert/strict";',
    'import { join } from "node:path";',
    'const scratch = "/fixture";',
    'let calls = 0; let observed: NodeJS.CallSite[] = [];',
    'Error.prepareStackTrace = function(error, sites) { calls++; observed = sites; assert.equal(this, Error); return `independent:${error.message}`; };',
    'function load(source: string, name: string) {',
    '  const path = join(scratch, name);',
    '  const wrapper = (0, eval)(`(function __bunwasm_cjs__(module){\\nvar exports=module.exports;\\n${source}\\nreturn module.exports;\\n})\\n//# sourceURL=${path}`.replaceAll("\\\\n", "\\n"));',
    '  const error: unknown = wrapper({ exports: {} });',
    '  assert.ok(error instanceof Error); return String(error.stack);',
    '}',
    source.slice(start, end),
    'const source = "/*😀中é*/module.exports = new\\t\\uFEFF\\u00A0Error(\'raw\');".replaceAll("\\\\t", "\\t").replaceAll("\\\\uFEFF", "\\uFEFF").replaceAll("\\\\u00A0", "\\u00A0");',
    'assert.deepEqual(loadObserved(source, "raw.cjs"), { raw: [{ line: 1, column: 26 }], formatted: "independent:raw" });',
    'assert.equal(calls, 1);',
    'const real = observed[0]; assert.ok(real);',
    'assert.equal(real.getFileName(), undefined); assert.equal(real.getLineNumber(), 3);',
    'assert.deepEqual(rawModulePosition(real, "/fixture/raw.cjs"), { line: 1, column: 26 });',
    'assert.deepEqual(rawModulePosition(real, "/fixture/raw.cjs"), { line: 1, column: 26 });',
    'assert.equal(real.getLineNumber(), 3);',
    'const direct = { getFileName: () => "/fixture/raw.cjs", getScriptNameOrSourceURL: () => "/unrelated.cjs", getEvalOrigin: () => "/unrelated.cjs", isEval: () => true, getLineNumber: () => 3, getColumnNumber: () => 26 };',
    'assert.deepEqual(rawModulePosition(direct, "/fixture/raw.cjs"), { line: 3, column: 26 });',
    'assert.deepEqual(rawModulePosition({ ...direct, isEval: () => false, getLineNumber: () => 1 }, "/fixture/raw.cjs"), { line: 1, column: 26 });',
    'const evaluated = { ...direct, getFileName: () => undefined, getScriptNameOrSourceURL: () => "/fixture/raw.cjs", getEvalOrigin: () => "/fixture/raw.cjs" };',
    'for (const changed of [{ getFileName: () => "/other.cjs" }, { getScriptNameOrSourceURL: () => "/other.cjs" }, { getEvalOrigin: () => "/other.cjs" }, { isEval: () => false }]) assert.equal(rawModulePosition({ ...evaluated, ...changed }, "/fixture/raw.cjs"), undefined);',
    'assert.throws(() => rawModulePosition({ ...evaluated, getLineNumber: () => 2 }, "/fixture/raw.cjs"));',
    'assert.throws(() => rawModulePosition({ ...direct, getColumnNumber: () => null }, "/fixture/raw.cjs"));',
    'for (const column of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => rawModulePosition({ ...direct, getColumnNumber: () => column }, "/fixture/raw.cjs"));',
    'assert.throws(() => loadObserved("module.exports = Error()", "unrelated.cts"));',
    'assert.throws(() => loadObserved("await Promise.resolve()", "unrelated.cjs"));',
    'assert.deepEqual(loadObserved("function fail() { return Error(\'two\'); } module.exports = fail();", "two.cjs"), { raw: [{ line: 1, column: 26 }, { line: 1, column: 59 }], formatted: "independent:two" });',
    'assert.deepEqual(loadObserved("void `x\\ny`; module.exports = Error(\'multi\');".replaceAll("\\\\n", "\\n"), "multi.cjs"), { raw: [{ line: 2, column: 22 }], formatted: "independent:multi" });',
    'console.log("Actual Node sourceURL wrapper, direct coordinates, exclusion and independent formatter pass");',
  ].join("\n");
}

test("raw stack fixture observes exact sourceURL wrappers without remapping direct frames", () => {
  assert.ok(scratch);
  const path = join(scratch, "raw-fixture-observer.ts");
  writeFileSync(path, rawFixtureObserverProbe());
  expect(execFileSync("node", [path], { encoding: "utf8", timeout: 30_000 })).toBe("Actual Node sourceURL wrapper, direct coordinates, exclusion and independent formatter pass\n");
});


test("raw stack contract rejects missing, duplicated or wrong observations and independent formatting", () => {
  const first = { line: 1, column: 32 };
  const raw = { line: 1, column: 26 };
  expect(() => verifyRawStackSources(() => ({ raw: [], formatted: first }))).toThrow();
  expect(() => verifyRawStackSources(() => ({ raw: [raw, raw], formatted: first }))).toThrow();
  expect(() => verifyRawStackSources(() => ({ raw: [{ line: 2, column: 26 }], formatted: first }))).toThrow();
  expect(() => verifyRawStackSources(() => ({ raw: [{ line: 1, column: 27 }], formatted: first }))).toThrow();
  expect(() => verifyRawStackSources(() => ({ raw: [raw], formatted: { line: 1, column: 33 } }))).toThrow();
});
