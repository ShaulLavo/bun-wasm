import { expect, test } from "bun:test";
import { engineOrder, median, parseEngineSpecs, parseMicroOutput } from "./bench-engines";

test("micro parser checks every section and checksum", () => {
  const output = [
    "loop 10 ms (1534387362)",
    "regexp 11 ms (1431980)",
    "json 12 ms (4924030)",
    "alloc 13 ms (1400000)",
    "strings 14 ms (98799)",
  ].join("\n");
  expect(parseMicroOutput(output)).toEqual({ loop: 10, regexp: 11, json: 12, alloc: 13, strings: 14 });
  expect(() => parseMicroOutput(output.replace("1534387362", "0"))).toThrow("loop checksum");
});

test("median handles odd and even sample counts", () => {
  expect(median([9, 1, 5])).toBe(5);
  expect(median([9, 1, 5, 3])).toBe(4);
});

test("engine order alternates without mutating the input", () => {
  const engines = parseEngineSpecs(["quickjs=dist/bun.wasm", "jsc=dist/bun-jsc.wasm"]);
  expect(engineOrder(engines, 0).map(engine => engine.name)).toEqual(["quickjs", "jsc"]);
  expect(engineOrder(engines, 1).map(engine => engine.name)).toEqual(["jsc", "quickjs"]);
  expect(engines.map(engine => engine.name)).toEqual(["quickjs", "jsc"]);
  expect(() => parseEngineSpecs(["same=a.wasm", "same=b.wasm"])).toThrow("unique");
});
