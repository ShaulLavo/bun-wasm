import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createScriptEvaluation } from "../src/script-evaluation.ts";

function evaluator() {
  const context = createContext({});
  return createScriptEvaluation(
    (source, filename) => runInContext(source, context, { filename }),
    (_filename, line, column) => [line * 2, column * 2],
  );
}

test("the real builtin loader can evaluate and cache a factory through the host natives", () => {
  const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/bun_builtins.ts", import.meta.url), "utf8");
  const factory: unknown = runInContext(new Bun.Transpiler({ target: "browser" }).transformSync(`globalThis.runtimeFactory = ${source}`, "ts"), createContext({}));
  if (typeof factory !== "function") throw new Error("Missing runtime factory");
  const loader: unknown = factory({
    bunBuiltinGlobals: { Array, Error, Function, Map, Object, Proxy, RangeError, Reflect, Set, String, Symbol, TypeError, URIError },
    native: {
      ...evaluator(),
      bunBuiltinNames: () => ["fixture"],
      bunBuiltinSource: () => '(function (intrinsics) { "use strict"; return { answer: intrinsics.String(42), receiver: this }; })',
      evalScript() { throw new Error("Builtins must use the trusted evaluator operation"); },
    },
  });
  if (!loader || typeof loader !== "object" || !("require" in loader) || typeof loader.require !== "function") throw new Error("Missing builtin loader");
  const first: unknown = loader.require("fixture");
  expect(first).toEqual({ answer: "42", receiver: undefined });
  expect(loader.require("fixture")).toBe(first);
});

test("builtin evaluation shares line offsets and resets stale offsets before evaluation", () => {
  const native = evaluator();
  const filename = "bun-builtin:fixture";
  native.evalBuiltin("42", filename, 9);
  expect(native.mapPosition(filename, 2, 3)).toEqual([10, 3]);
  native.evalScript("42", filename);
  expect(native.mapPosition(filename, 2, 3)).toEqual([4, 6]);
  native.evalScript("42", filename, 6);
  expect(() => native.evalBuiltin('throw new Error("builtin failure")', filename)).toThrow("builtin failure");
  expect(native.mapPosition(filename, 2, 3)).toEqual([4, 6]);
});

test("builtin evaluation preserves the source filename on thrown errors", () => {
  const native = evaluator();
  try {
    native.evalBuiltin('\nthrow new Error("builtin failure")', "bun-builtin:fixture");
    throw new Error("Expected builtin evaluation to throw");
  } catch (error) {
    expect(error).toHaveProperty("stack", expect.stringContaining("bun-builtin:fixture:2"));
  }
});

test("generic evaluation still accepts user values and builtin-looking filenames", () => {
  const native = evaluator();
  expect(native.evalScript({ toString: () => "40 + 2" }, "bun-builtin:user-input")).toBe(42);
  expect(native.evalScript("42")).toBe(42);
  expect(native.mapPosition("unseen.ts", 2, 3)).toEqual([4, 6]);
});
