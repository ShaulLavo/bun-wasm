import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const bun = process.versions.bun !== undefined;
const stdout = process.stdout;
assert.equal(stdout.isTTY, undefined);
for (const method of ["getWindowSize", "getColorDepth", "hasColors"]) {
  assert.equal(Reflect.get(stdout, method), undefined);
}
assert.equal(typeof Object.getOwnPropertyDescriptor(process, "stdout")?.get, bun ? "undefined" : "function");
assert.equal(stdout, process.stdout);
assert.equal(stdout.writable, true);
assert.equal(stdout.destroyed, false);
assert.equal(stdout.cork(), undefined);
assert.equal(stdout.uncork(), undefined);
assert.equal(stdout.setDefaultEncoding("utf8"), stdout);

const raw = { identity: true };
assert.throws(() => Object.defineProperty(process.env, "TS_PROCESS_ACCESSOR", { get: () => raw }), TypeError);
assert.throws(() => Reflect.set(process.env, Symbol("environment"), raw), TypeError);
assert.equal(Reflect.set(process.env, "TS_PROCESS", 17), true);
assert.equal(process.env.TS_PROCESS, "17");
delete process.env.TS_PROCESS;

const listener = () => {};
EventEmitter.prototype.on.call(process, "SIGIO", listener);
process.on("SIGPOLL", listener);
assert.equal(process.listenerCount("SIGIO"), bun ? 0 : 1);
assert.equal(process.listenerCount("SIGPOLL"), 1);
process.removeListener("SIGIO", listener);
process.removeListener("SIGPOLL", listener);

const warning = new Error("same warning");
let warnings = 0;
process.on("warning", value => { assert.equal(value, warning); warnings++; });
process.emitWarning(warning);
const order: string[] = [];
stdout.write("", error => { assert.equal(error, null); order.push("write"); });
process.nextTick(() => order.push("tick"));

const input: string[] = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input.push(String(chunk)));
process.stdin.on("end", () => {
  assert.equal(input.join(""), "fixture input");
  assert.equal(process.stdin.readable, false);
  assert.equal(process.stdin.read(), null);
  assert.deepEqual(order, ["write", "tick"]);
  assert.equal(warnings, 1);
  console.log("PASS native pipe process controls", bun ? "bun" : "node");
});
assert.equal(process.stdin.resume(), process.stdin);
