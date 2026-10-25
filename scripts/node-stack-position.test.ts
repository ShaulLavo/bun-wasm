import { expect, test } from "bun:test";
import { newTokenLength } from "../tests/fixtures/stack-source-position/contract";
import { stackFormatter, stackSite } from "./node-stack-position-fixture";

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
  if (!mapped || typeof mapped !== "object" || !("add" in mapped) || typeof mapped.add !== "function") throw new Error("mapped call sites set missing");
  mapped.add(site);
  expect(formatter.format(site)).toBe("caller (/huge.cjs:3:12)");
  expect(calls).toHaveLength(2);
  const failing = stackFormatter({ engine: "host", mapPosition: () => undefined, sourceNewOffset() { throw new Error("source unavailable"); } });
  expect(failing.format(stackSite(7))).toBe("caller (/huge.cjs:1:7)");
  const portable = stackFormatter({ engine: "jsc", mapPosition: () => undefined, sourceNewOffset() { throw new Error("not used"); } });
  expect(portable.format({ ...stackSite(7), getFunction: () => function caller() {} })).toBe("caller (/huge.cjs:1:7)");
});
