import assert from "node:assert/strict";
import { Glob } from "bun";
import locations from "./locations.json";

const NativeError = Error;
function capture(trigger: () => unknown) {
  try { trigger(); } catch (error) { return error; }
  throw new NativeError("Expected the Glob operation to throw");
}
function checkLocation(trigger: () => unknown, expected: { line: number; columns: number[] }) {
  const error = capture(trigger);
  assert.ok(error instanceof NativeError);
  const frame = /bun-wasm:glob:(\d+):(\d+)/.exec(String(error.stack));
  assert.ok(frame, String(error.stack));
  assert.equal(Number(frame[1]), expected.line);
  assert.ok(expected.columns.includes(Number(frame[2])), `column ${frame[2]} is outside the source constructor token`);
}
checkLocation(() => new Glob(), locations.constructor);
checkLocation(() => new Glob("*").match(), locations.match);
checkLocation(() => new Glob("*").scanSync(false), locations.scan);
console.log("runtime TypeScript source locations");

class ReplacementError extends NativeError { name = "ReplacementError"; }
class ReplacementTypeError extends NativeError { name = "ReplacementTypeError"; }
const saved = { Error, TypeError };
const cases: [() => unknown, typeof NativeError, string][] = [
  [() => new Glob(), ReplacementTypeError, "Glob.constructor: expected 1 arguments, got 0"],
  [() => new Glob(7), ReplacementTypeError, "Glob.constructor: first argument is not a string"],
  [() => new Glob("*").match(), ReplacementTypeError, "Glob.matchString: expected 1 arguments, got 0"],
  [() => new Glob("*").match(7), ReplacementTypeError, "Glob.matchString: first argument is not a string"],
  [() => new Glob("*").scanSync(false), ReplacementTypeError, "Expected options to be an object"],
  [() => new Glob("*").scanSync({ cwd: false }), ReplacementTypeError, "Expected cwd to be a string"],
  [() => new Glob("*").scanSync({ cwd: "/".repeat(4097) }), ReplacementError, "ENAMETOOLONG: name too long, scandir"],
];
let errors: unknown[];
try {
  globalThis.TypeError = ReplacementTypeError;
  globalThis.Error = ReplacementError;
  errors = cases.map(([trigger]) => capture(trigger));
} finally {
  globalThis.TypeError = saved.TypeError;
  globalThis.Error = saved.Error;
}
for (let i = 0; i < cases.length; i++) {
  const [, Ctor, message] = cases[i];
  const error = errors[i];
  assert.ok(error instanceof Ctor);
  assert.equal(Object.getPrototypeOf(error), Ctor.prototype);
  assert.equal(error.name, Ctor === ReplacementError ? "ReplacementError" : "ReplacementTypeError");
  assert.equal(error.message, message);
  assert.ok(String(error.stack).includes("bun-wasm:glob"));
}
assert.equal(errors[errors.length - 1].code, "ENAMETOOLONG");
console.log("runtime TypeScript replacement error constructors");
