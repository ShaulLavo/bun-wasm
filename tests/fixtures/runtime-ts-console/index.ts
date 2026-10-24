import assert from "node:assert/strict";
import { Console } from "node:console";
import { Writable } from "node:stream";

const chunks: string[] = [];
const stdout = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); } });
const instance = new Console({ stdout, colorMode: false, groupIndentation: 2 });
instance.log("%s %d %j", "value", 7, { a: true });
instance.assert(false, "reason %d", 3);
instance.group("outer");
instance.log("a\nb");
instance.groupEnd();
instance.count("label");
instance.countReset("label");
instance.count("label");
assert.equal(chunks.join(""), 'value 7 {"a":true}\nAssertion failed: reason 3\nouter\n  a\n  b\nlabel: 1\nlabel: 1\n');
console.log("formatting, routing, groups and counters");

const failure = new Error("exact stream error");
const throwing = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
throwing.write = () => { throw failure; };
assert.throws(() => new Console(throwing, throwing, false).log("value"), error => error === failure);
new Console(throwing).log("ignored");
console.log("native write error identity");

for (const [options, code] of [
  [{ stdout, colorMode: "invalid" }, "ERR_INVALID_ARG_VALUE"],
  [{ stdout, groupIndentation: NaN }, "ERR_OUT_OF_RANGE"],
  [{ stdout, inspectOptions: [] }, "ERR_INVALID_ARG_TYPE"],
  [{ stdout, inspectOptions: { colors: true }, colorMode: false }, "ERR_INCOMPATIBLE_OPTION_PAIR"],
] as const) {
  assert.throws(() => Reflect.construct(Console, [options]), error => error instanceof TypeError || error instanceof RangeError
    ? "code" in error && error.code === code : false);
}
console.log("option validation codes and native constructors");

const detached = instance.log;
detached("detached");
assert.equal(chunks.at(-1), "detached\n");
assert.equal(Object.getOwnPropertyDescriptor(console, Symbol.toStringTag)?.value, "console");
assert.equal(console.Console, Console);
assert.equal(console._stdout, process.stdout);
assert.equal(console._stderr, process.stderr);
console.log("detached methods, lazy constructor and stdio descriptors");
