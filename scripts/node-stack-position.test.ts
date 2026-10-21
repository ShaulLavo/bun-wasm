import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStackProbe, stackFormatter, stackSite } from "./node-stack-position-fixture";
import { newTokenLength, tokenCases, verifyTokenLengths } from "../tests/fixtures/stack-source-position/contract";

test("production stack formatting does not transfer complete minified source lines", () => {
  const source = "new Error();/*" + "x".repeat(1024 * 1024) + "*/";
  let fullLineCalls = 0;
  let fullLineBytes = 0;
  let offsets = 0;
  const formatter = stackFormatter({
    engine: "host", mapPosition: () => undefined,
    getSourceLine() { fullLineCalls++; fullLineBytes += Buffer.byteLength(source); return source; },
    sourceNewOffset(_file: string, _line: number, column: number) { offsets++; return newTokenLength(source, column); },
  });
  for (let index = 0; index < 32; index++) expect(formatter.format(stackSite(1))).toBe("caller (/huge.cjs:1:5)");
  console.log(JSON.stringify({ fullLineCalls, fullLineBytes, offsets }));
  expect(fullLineCalls).toBe(0);
  expect(offsets).toBe(32);
});

let scratch: string | undefined;
let probe = "";
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stack-native-"));
  const source = join(scratch, "probe.rs");
  writeFileSync(source, nativeStackProbe());
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

test("production formatter preserves mapping order, once-only mapping and native failures", () => {
  const calls: unknown[] = [];
  const formatter = stackFormatter({
    engine: "host", mapPosition(file: string, line: number, column: number) { calls.push(["map", file, line, column]); return [2, 3]; },
    sourceNewOffset(file: string, line: number, column: number) { calls.push(["offset", file, line, column]); return 6; },
    getSourceLine() { throw new Error("full line must not be requested"); },
  });
  expect(formatter.format(stackSite(40, 5))).toBe("caller (/huge.cjs:2:9)");
  expect(calls).toEqual([["map", "/huge.cjs", 5, 40], ["offset", "/huge.cjs", 2, 3]]);
  const site = stackSite(12, 3);
  const mapped: unknown = Reflect.get(formatter.internal, "mappedCallSites");
  assert.ok(mapped && typeof mapped === "object" && "add" in mapped && typeof mapped.add === "function");
  mapped.add(site);
  expect(formatter.format(site)).toBe("caller (/huge.cjs:3:12)");
  expect(calls).toHaveLength(2);
  const failing = stackFormatter({ engine: "host", mapPosition: () => undefined, sourceNewOffset() { throw new Error("source unavailable"); } });
  expect(failing.format(stackSite(7))).toBe("caller (/huge.cjs:1:7)");
  const portable = stackFormatter({ engine: "jsc", mapPosition: () => undefined, sourceNewOffset() { throw new Error("not used"); } });
  expect(portable.format({ ...stackSite(7), getFunction: () => function caller() {} })).toBe("caller (/huge.cjs:1:7)");
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
