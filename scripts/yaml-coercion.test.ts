import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";

function yaml() {
  const context = { Number, String, Boolean };
  const directory = mkdtempSync(join(tmpdir(), "bun-wasm-yaml-"));
  function factory(name: string) {
    const destination = join(directory, `${name}.js`);
    const result = Bun.spawnSync(["node", new URL("./transpile-runtime.ts", import.meta.url).pathname,
      new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url).pathname, destination]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return runInNewContext(readFileSync(destination, "utf8"), context);
  }
  try {
    const internal = { native: {}, require: (name: string) => factory(name)(internal) };
    return factory("formats")(internal).YAML;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function throwingPrimitive(sentinel: Error) {
  return () => { throw sentinel; };
}

for (const Wrapper of [String, Number]) {
  for (const place of ["root", "property", "space"]) {
    test(`${Wrapper.name} throwing coercion preserves identity at ${place}`, () => {
      const sentinel = new Error("coercion");
      const value = Object.assign(new Wrapper(1), { [Symbol.toPrimitive]: throwingPrimitive(sentinel) });
      const stringify = yaml().stringify;
      expect(() => place === "space" ? stringify({}, null, value) : stringify(place === "root" ? value : { value })).toThrow(sentinel);
    });
  }
}

test("invalid exotic primitive result has the Bun diagnostic", () => {
  const value = Object.assign(new String(""), { [Symbol.toPrimitive]() { return String; } });
  expect(() => yaml().stringify(value)).toThrow("Symbol.toPrimitive returned an object");
});

test("YAML preserves coercion hints, numeric conversion and boolean internal value", () => {
  const hints: string[] = [];
  const text = Object.assign(new String("old"), { [Symbol.toPrimitive](hint: string) { hints.push(hint); return "new"; } });
  const number = Object.assign(new Number(1), { [Symbol.toPrimitive](hint: string) { hints.push(hint); return "7"; } });
  const boolean = Object.assign(new Boolean(true), { [Symbol.toPrimitive]() { throw new Error("not consulted"); } });
  expect(yaml().stringify({ text, number, boolean })).toBe("{text: new,number: 7,boolean: true}");
  expect(hints).toEqual(["string", "number", "string", "number"]);
});
