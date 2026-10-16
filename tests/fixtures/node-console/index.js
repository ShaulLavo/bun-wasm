import nodeConsole, { Console } from "node:console";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

function capture(extra = {}) {
  const chunks = [];
  const stream = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  Object.assign(stream, extra);
  return { stream, text: () => chunks.join("") };
}
const out = capture();
const err = capture();
const c = new Console(out.stream, err.stream, false);
assert.equal(nodeConsole, console);
assert.equal(console.Console, Console);
assert(console instanceof Console);
assert(c instanceof Console);
assert.equal(console._stdout, process.stdout);
assert.equal(console._stderr, process.stderr);
assert.equal(Object.getOwnPropertyDescriptor(console, "_stdout").enumerable, false);
for (const method of ["log", "info", "debug", "dirxml"]) c[method]("%s %d", method, 7);
c.dir({ foo: "bar" });
c.assert(true, "hidden");
c.assert(false, "bad %s", "assertion");
c.warn("warn");
c.error("error");
const { log } = c;
log("detached");
assert.equal(out.text(), "log 7\ninfo 7\ndebug 7\ndirxml 7\n{ foo: 'bar' }\ndetached\n");
assert.equal(err.text(), "Assertion failed: bad assertion\nwarn\nerror\n");
console.log("streams, identity, detached methods");

const grouped = capture();
const g = new Console({ stdout: grouped.stream, groupIndentation: 3, colorMode: false });
g.group("outer");
g.log("a\nb");
g.groupCollapsed();
g.warn("inner");
g.groupEnd();
g.count("x");
g.count("x");
g.countReset("x");
g.count("x");
g.groupEnd();
g.groupEnd();
g.log("end");
assert.equal(grouped.text(), "outer\n   a\n   b\n      inner\n   x: 1\n   x: 2\n   x: 1\nend\n");
const other = capture();
new Console(other.stream).count("x");
assert.equal(other.text(), "x: 1\n");
console.log("independent state and indentation");

const colored = capture();
new Console({ stdout: colored.stream, colorMode: true }).log({ foo: "bar" });
assert.equal(colored.text(), "{ foo: \x1b[32m'bar'\x1b[39m }\n");
const shallow = capture();
new Console({ stdout: shallow.stream, inspectOptions: { depth: 0, colors: false } }).log({ nested: { n: 1 } });
assert.equal(shallow.text(), "{ nested: [Object] }\n");
const tty = capture({ isTTY: true, getColorDepth: () => 8 });
new Console({ stdout: tty.stream }).log(1);
assert.equal(tty.text(), "\x1b[33m1\x1b[39m\n");
console.log("color mode and inspection options");

for (const [options, code] of [
  [{}, "ERR_CONSOLE_WRITABLE_STREAM"],
  [{ stdout: {} }, "ERR_CONSOLE_WRITABLE_STREAM"],
  [{ stdout: out.stream, stderr: {} }, "ERR_CONSOLE_WRITABLE_STREAM"],
  [{ stdout: out.stream, colorMode: "bad" }, "ERR_INVALID_ARG_VALUE"],
  [{ stdout: out.stream, groupIndentation: -1 }, "ERR_OUT_OF_RANGE"],
  [{ stdout: out.stream, groupIndentation: 1001 }, "ERR_OUT_OF_RANGE"],
  [{ stdout: out.stream, groupIndentation: "2" }, "ERR_INVALID_ARG_TYPE"],
  [{ stdout: out.stream, inspectOptions: null }, "ERR_INVALID_ARG_TYPE"],
  [{ stdout: out.stream, colorMode: false, inspectOptions: { colors: true } }, "ERR_INCOMPATIBLE_OPTION_PAIR"],
]) assert.throws(() => new Console(options), { code });
const throwing = new Writable({ write(chunk, encoding, cb) { cb(); } });
throwing.write = () => { throw new Error("write failed"); };
new Console(throwing).log("ignored");
assert.throws(() => new Console(throwing, throwing, false).log("not ignored"), /write failed/);
assert(Console(out.stream) instanceof Console);
console.log("constructor validation and write errors");

const specialOut = capture();
const specialErr = capture();
const special = new Console({ stdout: specialOut.stream, stderr: specialErr.stream, colorMode: false });
special.table([{ a: 1 }]);
assert.match(specialOut.text(), /\(index\)/);
special.trace("trace message");
assert.match(specialErr.text(), /index.js/);
special.time("clock");
special.timeLog("clock", "extra");
special.timeEnd("clock");
assert.equal(special._times.size, 0);
assert.match(specialOut.text(), /clock: .*extra/);
special.clear();
console.log("table, trace, timers");
