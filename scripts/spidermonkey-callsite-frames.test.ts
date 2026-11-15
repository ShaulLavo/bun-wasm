import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface Frame { name: string; file: string; line: number; column: number }
type Reader = (error: unknown, raw: unknown, excludeSelfHosted: boolean) => unknown;
const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/inspect.js", import.meta.url), "utf8");

function inspector(engine: string, reader?: Reader, hooks: object = {}) {
  const factory: (internal: object) => { errorFrames(error: unknown, raw: unknown): Frame[] } = runInNewContext(
    'globalThis[Symbol.for("bunwasm.internal.spidermonkey.errorFrames")] = reader;\n' + source,
    { reader },
  );
  return factory({ native: { engine, preparedSourceName: () => undefined }, ...hooks });
}

test("SpiderMonkey CallSite frames use decoded native identities without reading stack again", () => {
  const error = Object.defineProperty({}, "stack", { get() { throw new Error("recursive stack read"); } });
  const raw = "raw@/encoded%2500.ts:1:2";
  const files = ["%00", "/virtual\0%25.ts", "/literal%00%25-雪.ts", "/line\nbreak.ts"];
  const mappings: unknown[][] = [];
  const stack = inspector("spidermonkey", (target, text, exclude) => {
    expect(target).toBe(error);
    expect(text).toBe(raw);
    expect(exclude).toBe(true);
    return files.map(file => ({ name: "capture", file, line: 1, column: 2 }));
  }, { mapPosition: (...args: unknown[]) => { mappings.push(args); return [7, 9]; } });
  expect(stack.errorFrames(error, raw)).toEqual(files.map(file => ({ name: "capture", file, line: 7, column: 9 })));
  expect(mappings).toEqual(files.map(file => [file, 1, 2]));
});

test("an empty native trace stays empty instead of reviving raw frames", () => {
  expect(inspector("spidermonkey", () => []).errorFrames({}, "raw@/raw.ts:1:2")).toEqual([]);
});

for (const [name, reader] of [
  ["absent", undefined],
  ["unavailable", () => undefined],
  ["throws", () => { throw new Error("metadata unavailable"); }],
] satisfies [string, Reader | undefined][]) {
  test(`SpiderMonkey preserves raw fallback when native metadata ${name}`, () => {
    expect(inspector("spidermonkey", reader).errorFrames({}, "capture@/literal%00.ts:3:4"))
      .toEqual([{ name: "capture", file: "/literal%00.ts", line: 3, column: 4 }]);
  });
}

for (const engine of ["quickjs", "jsc", "host"]) {
  test(`${engine} frame parsing does not call SpiderMonkey metadata`, () => {
    let calls = 0;
    const stack = inspector(engine, () => { calls++; return []; });
    expect(stack.errorFrames({}, "capture@/literal%00.ts:3:4"))
      .toEqual([{ name: "capture", file: "/literal%00.ts", line: 3, column: 4 }]);
    expect(calls).toBe(0);
  });
}
