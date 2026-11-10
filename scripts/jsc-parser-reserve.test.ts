import { expect, test } from "bun:test";
import { effectiveParserReserve } from "../web/src/engine-stack-budget.ts";
import { capacitiesAt, fileThreshold, parserReserveControls, type ProbeHost, type StackSettings } from "./jsc-parser-reserve.ts";
import { chainCapacities, chainMaximum, chainModes, chainOwnership, guestStackSettings, reserveSiteChains } from "./stack-measurement.ts";

type ReserveRule = (value: string | undefined) => number;

/** A guest whose parser stops when budget plus 64 KiB is spent, at `reserve(value)` plus a real frame per level. */
function modelHost(reserve: ReserveRule = effectiveParserReserve, reported?: (settings: StackSettings) => object): ProbeHost {
  return (settings, mode, depth) => {
    const room = settings.budgetKib * 1024 + 65536 - 22000;
    const capacities = Object.fromEntries(chainModes.map((name, index) => [name, Math.floor(room / (reserve(settings.parserReserve) + 380 + index))]));
    const guest = reported?.(settings) ?? { budget: String(settings.budgetKib), parserReserve: settings.parserReserve ?? null };
    return { code: 0, output: `settings ${JSON.stringify(guest)}\ncapacities ${JSON.stringify(capacities)}\ncompleted ${mode} ${depth}\ncontinued\n` };
  };
}

test("the tuples pass on a guest that follows the setting's rule", () => {
  const records = parserReserveControls(modelHost());
  expect(records.slice(0, 3).map(record => record.requested)).toEqual([{ budgetKib: 192 }, { budgetKib: 208 }, { budgetKib: 800 }]);
  expect(records.find(record => record.requested.parserReserve === "1000")?.effectiveParserReserve).toBe(1008);
  expect(records.find(record => record.requested.parserReserve === "1024kb")?.effectiveParserReserve).toBe(2048);
  for (const record of records) expect(Object.keys(record.capacities)).toEqual(chainModes);
});

const brokenGuests: { fault: string; reserve: ReserveRule; message: string }[] = [
  { fault: "ignores the setting", reserve: () => 2048, message: "is not below" },
  { fault: "clamps a value below the range", reserve: value => (value === "511" ? 512 : effectiveParserReserve(value)), message: "is not equal to" },
  { fault: "accepts trailing text", reserve: value => effectiveParserReserve(value?.replace(/kb$/, "")), message: "is not equal to" },
  { fault: "accepts a sign", reserve: value => effectiveParserReserve(value?.replace(/^\+/, "")), message: "is not equal to" },
  { fault: "trims whitespace", reserve: value => effectiveParserReserve(value?.trim()), message: "is not equal to" },
  { fault: "reads an empty value as the minimum", reserve: value => (value === "" ? 512 : effectiveParserReserve(value)), message: "is not equal to" },
  { fault: "rounds down", reserve: value => (value === "1000" ? 992 : effectiveParserReserve(value)), message: "is not equal to" },
  { fault: "does not round", reserve: value => (value === "1009" ? 1009 : effectiveParserReserve(value)), message: "is not equal to" },
  { fault: "reverses the value", reserve: value => 2560 - effectiveParserReserve(value), message: "is not below" },
];
for (const { fault, reserve, message } of brokenGuests) {
  test(`the tuples reject a guest that ${fault}`, () => {
    expect(() => parserReserveControls(modelHost(reserve))).toThrow(message);
  });
}

test("a capacity counts only from a guest that reports the requested settings and continues", () => {
  const requested = { budgetKib: 192, parserReserve: "1024" };
  expect(capacitiesAt(modelHost(), requested)).toMatchObject({ requested, effectiveParserReserve: 1024 });
  expect(() => capacitiesAt(modelHost(undefined, () => ({ budget: "192", parserReserve: null })), requested)).toThrow("reported other settings");
  expect(() => capacitiesAt(modelHost(undefined, settings => ({ budget: "208", parserReserve: settings.parserReserve ?? null })), requested)).toThrow("reported other settings");
  const trapped: ProbeHost = () => ({ code: 1, output: "wasm call stack exhausted" });
  expect(() => capacitiesAt(trapped, requested)).toThrow("trap");
  const silent: ProbeHost = (settings, mode, depth) => ({ code: 0, output: `completed ${mode} ${depth}\n` });
  expect(() => capacitiesAt(silent, requested)).toThrow("missing-continuation");
  const overflowed: ProbeHost = (settings, mode, depth) => ({ code: 0, output: `caught ${mode} RangeError ${depth} overflow\ncontinued\n` });
  expect(() => capacitiesAt(overflowed, requested)).toThrow("caught:RangeError");
});

test("the probe's settings and capacities lines are read strictly", () => {
  expect(guestStackSettings("settings {\"budget\":\"192\",\"parserReserve\":null}\ncompleted plain 1\n")).toEqual({ budget: "192", parserReserve: null });
  expect(guestStackSettings("completed plain 1\n")).toBeNull();
  expect(() => guestStackSettings("settings {\"budget\":192,\"parserReserve\":null}\n")).toThrow("Malformed");
  const capacities = Object.fromEntries(chainModes.map(mode => [mode, 7]));
  expect(chainCapacities(`capacities ${JSON.stringify(capacities)}\n`)).toEqual(capacities);
  expect(chainModes).toHaveLength(20);
  expect(chainMaximum).toBe(4096);
  expect(() => chainCapacities("completed chainCapacity 4096\n")).toThrow("Expected one capacities line");
  expect(() => chainCapacities(`capacities ${JSON.stringify({ ...capacities, chainAssignCall8: -1 })}\n`)).toThrow("Malformed");
  expect(() => chainCapacities(`capacities ${JSON.stringify({ ...capacities, other: 1 })}\n`)).toThrow("Malformed");
  expect(() => chainCapacities(`capacities ${JSON.stringify({ chainAssignCall8: 1 })}\n`)).toThrow("Missing");
});

test("a parent-and-Worker record needs both parent measurements and a completed child", () => {
  const capacities = Object.fromEntries(chainModes.map(mode => [mode, 9]));
  const transcript = (code: number, continued = true) => ({ code, output: encodeURIComponent(
    `settings {"budget":"192","parserReserve":"512"}\ncapacities ${JSON.stringify(capacities)}\ncompleted chainCapacity 4096\n${continued ? "continued\n" : ""}`) });
  const line = (child: object) => `settings {"budget":"192","parserReserve":"1024"}\nownership ${JSON.stringify({ before: capacities, child, after: capacities })}\ncompleted chainWorker 4096\ncontinued\n`;
  expect(chainOwnership(line(transcript(0)), 4096)).toEqual({ before: capacities, child: { settings: { budget: "192", parserReserve: "512" }, capacities }, after: capacities });
  expect(reserveSiteChains).toHaveLength(8);
  expect(() => chainOwnership(line(transcript(1)), 4096)).toThrow("did not complete: trap");
  expect(() => chainOwnership(line(transcript(0, false)), 4096)).toThrow("did not complete: missing-continuation");
  expect(() => chainOwnership(line(transcript(0)), 2048)).toThrow("did not complete: invalid-output");
  expect(() => chainOwnership("completed chainWorker 4096\ncontinued\n", 4096)).toThrow("Expected one ownership line");
  expect(() => chainOwnership(`ownership ${JSON.stringify({ before: capacities, child: transcript(0) })}\n`, 4096)).toThrow("Malformed chain ownership");
});

test("the file threshold is the largest grid value at which every file loads with 16 KiB less", () => {
  const limits: Record<string, number> = { "babel.js": 1900, "next.js": 1000 };
  const seen: StackSettings[] = [];
  const loads = (settings: StackSettings, file: string) => { seen.push(settings); return Number(settings.parserReserve) <= limits[file]!; };
  const result = fileThreshold(loads, 208, Object.keys(limits));
  expect(result).toMatchObject({ budgetKib: 208, measuredAtKib: 192, threshold: 960, monotonic: true });
  expect(result.rows.map(row => row.value)).toEqual(Array.from({ length: 24 }, (_, index) => 512 + index * 64));
  expect(new Set(seen.map(settings => settings.budgetKib))).toEqual(new Set([192]));
  expect(result.rows.find(row => row.value === 1024)?.loads).toEqual({ "babel.js": true, "next.js": false });
});

test("no grid value, or a value that loads above one that does not, gives no threshold", () => {
  expect(fileThreshold(() => false, 192, ["next.js"])).toMatchObject({ threshold: null, monotonic: true });
  const gap = fileThreshold(settings => settings.parserReserve !== "576", 192, ["next.js"]);
  expect(gap).toMatchObject({ threshold: null, monotonic: false });
});
