import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/stack_capability.ts", import.meta.url), "utf8");
const probe = new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.probe = ${source};`);

for (const hook of ["absent", "data", "accessor"]) {
  for (const structured of [true, false]) {
    test(`probe preserves ${hook} hook and descriptor with ${structured ? "lazy native" : "text"} capture`, () => {
      const result = runInNewContext(`
        class Error {}
        const previous = () => "previous";
        let current = previous;
        const accessors = { configurable: true, enumerable: false, get() { return current; }, set(value) { current = value; } };
        if (hook === "data") Object.defineProperty(Error, "prepareStackTrace", { value: previous, writable: true, configurable: true, enumerable: true });
        if (hook === "accessor") Object.defineProperty(Error, "prepareStackTrace", accessors);
        const before = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
        Error.captureStackTrace = holder => Object.defineProperty(holder, "stack", { get() { return structured ? Error.prepareStackTrace(holder, []) : "raw text"; } });
        ${probe}
        const supported = globalThis.probe();
        const after = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
        const restored = before === undefined ? after === undefined : Object.keys(before).every(key => before[key] === after[key]);
        ({ supported, restored, current: current === previous, hook: Error.prepareStackTrace === (hook === "absent" ? undefined : previous) });
      `, { hook, structured });
      expect(result).toEqual({ supported: structured, restored: true, current: true, hook: true });
    });
  }
}

test("a throwing native capture restores the formatter before propagating the original error", () => {
  expect(runInNewContext(`
    const token = {};
    class Error {}
    const previous = () => "previous";
    Error.prepareStackTrace = previous;
    Error.captureStackTrace = () => { throw token; };
    ${probe}
    let caught;
    try { globalThis.probe(); } catch (error) { caught = error; }
    caught === token && Error.prepareStackTrace === previous;
  `)).toBe(true);
});

test("an engine without native capture has no structured capture capability", () => {
  expect(runInNewContext(`class Error {} ${probe} globalThis.probe()`)).toBe(false);
});
