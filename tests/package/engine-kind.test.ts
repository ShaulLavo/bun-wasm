import { expect, test } from "bun:test";
import { appendCustomSection, ENGINE_SECTION, parseProgramFiles, programKind, programKindForBuild, tagProgramCore, verifyProgramSide } from "../../src/engine-kind";
import { quickjsPair } from "./quickjs-plan-fixture";

const single = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
const rawCore = () => {
  const { core } = quickjsPair();
  return core.slice(0, -(3 + ENGINE_SECTION.length + "quickjs".length));
};
const declared = (core: Uint8Array, payload: Uint8Array) => appendCustomSection(core, ENGINE_SECTION, payload);

test("generic bind and exact engine section agree before instantiation", () => {
  expect(programKind(new WebAssembly.Module(single))).toBe("single");
  expect(() => programKind(new WebAssembly.Module(rawCore()))).toThrow("exactly one");
  const kinds = ["quickjs", "jsc"] as const;
  for (const kind of kinds) {
    const { core, side } = quickjsPair(kind);
    expect(programKind(new WebAssembly.Module(core))).toBe(kind);
    expect(() => verifyProgramSide(kind, new WebAssembly.Module(side))).not.toThrow();
    for (const other of kinds.filter(other => other !== kind)) {
      expect(() => verifyProgramSide(other, new WebAssembly.Module(side))).toThrow("initializer/RUN");
    }
    expect(() => tagProgramCore(core, kind)).toThrow("untagged");
  }
});

test("missing, duplicate, malformed and contradictory declarations reject", () => {
  for (const payload of [new Uint8Array(), Uint8Array.from([0xc0, 0xaf]), ...["quickjs\0", " jsc", "jsc\n", "hermes", "hermes\0", "Hermes", "spidermonkey", "other"].map(value => new TextEncoder().encode(value))]) {
    expect(() => programKind(new WebAssembly.Module(declared(rawCore(), payload)))).toThrow("Invalid bun-wasm-engine");
  }
  const { core } = quickjsPair();
  const tag = new TextEncoder().encode("jsc");
  expect(() => programKind(new WebAssembly.Module(declared(core, tag)))).toThrow("exactly one");
  expect(() => programKind(new WebAssembly.Module(declared(single, tag)))).toThrow("bind function");
  const label = Array.from(new TextEncoder().encode("bun_core_bind_engine"));
  const memoryBinding = Uint8Array.from(Array.from(single).concat([5, 3, 1, 0, 1, 7, label.length + 4, 1, label.length], label, [2, 0]));
  expect(() => programKind(new WebAssembly.Module(declared(memoryBinding, tag)))).toThrow("bind function");
});

test("unknown JSON cannot create contradictory or legacy program files", () => {
  const parse = (value: unknown) => { if (typeof value !== "number") throw new TypeError("number required"); return value; };
  expect(parseProgramFiles({ kind: "single", core: 1 }, parse)).toEqual({ kind: "single", core: 1 });
  expect(parseProgramFiles({ kind: "jsc", core: 1, side: 2 }, parse)).toEqual({ kind: "jsc", core: 1, side: 2 });
  expect(() => parseProgramFiles({ kind: "hermes", core: 1, side: 2 }, parse)).toThrow();
  for (const value of [null, { core: 1, quickjs: 2 }, { kind: "jsc", core: 1 }, { kind: "single", core: 1, side: 2 }, { kind: "quickjs", core: 1, side: 2, jsc: 3 }, { kind: "unknown", core: 1, side: 2 }]) {
    expect(() => parseProgramFiles(value, parse)).toThrow();
  }
  expect(programKindForBuild("quickjs-minimal")).toBe("quickjs");
  expect(programKindForBuild("jsc")).toBe("jsc");
  expect(() => programKindForBuild("hermes")).toThrow("Unknown guest build");
  expect(programKindForBuild("tools")).toBe("single");
  expect(() => programKindForBuild("unknown")).toThrow("Unknown guest build");
});
