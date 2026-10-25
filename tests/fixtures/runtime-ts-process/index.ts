import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const raw = { identity: true };
const key = Symbol("environment");
process.env.TS_PROCESS = 17;
assert.equal(process.env.TS_PROCESS, "17");
let accessor = "unsupported";
try {
  Object.defineProperty(process.env, "TS_PROCESS_ACCESSOR", { get: () => raw, configurable: true, enumerable: true });
  accessor = process.env.TS_PROCESS_ACCESSOR === raw ? "raw" : "coerced";
} catch (error) {
  assert.equal(error instanceof TypeError, true);
}
let symbol = "unsupported";
try { process.env[key] = raw; symbol = process.env[key] === raw ? "raw" : "coerced"; }
catch (error) { assert.equal(error instanceof TypeError, true); }
console.log("env", process.env.TS_PROCESS, accessor, symbol);
delete process.env.TS_PROCESS;
delete process.env.TS_PROCESS_ACCESSOR;
delete process.env[key];

const stdout = process.stdout;
assert.equal(stdout, process.stdout);
const descriptor = Object.getOwnPropertyDescriptor(process, "stdout");
console.log("stdout getter", typeof descriptor.get, descriptor.enumerable, descriptor.configurable);
console.log("stdout keys", Reflect.ownKeys(stdout).map(String).join(","));
console.log("stdout states", stdout.writable, stdout.destroyed, stdout._writableState.ended);
assert.equal(stdout.cork(), undefined);
assert.equal(stdout.uncork(), undefined);
assert.equal(stdout.setDefaultEncoding("utf8"), stdout);
console.log("window", JSON.stringify(stdout.getWindowSize()), stdout.getColorDepth(), stdout.hasColors());

const warning = new Error("same warning");
let warnings = 0;
process.on("warning", value => { assert.equal(value, warning); warnings++; });
process.emitWarning(warning);
const order: string[] = [];
stdout.write("write control\n", error => { assert.equal(error, null); order.push("write"); });
process.nextTick(() => order.push("tick"));

const listener = () => {};
EventEmitter.prototype.on.call(process, "SIGIO", listener);
process.on("SIGPOLL", listener);
assert.equal(process.listenerCount("SIGIO"), 1);
assert.equal(process.listenerCount("SIGPOLL"), 1);
process.removeListener("SIGIO", listener);
process.removeListener("SIGPOLL", listener);
console.log("signals", process.listenerCount("SIGIO"), process.listenerCount("SIGPOLL"));

const input: string[] = [];
process.stdin.on("data", chunk => input.push(String(chunk)));
process.stdin.setEncoding("utf8");
assert.equal(process.stdin.resume(), process.stdin);
assert.equal(process.stdin.pause(), process.stdin);
assert.equal(process.stdin.resume(), process.stdin);
process.stdin.on("close", async () => {
  console.log("reader", input.join(""), process.stdin.readable, process.stdin.read());
  const after: unknown[] = [];
  for await (const chunk of process.stdin) after.push(chunk);
  console.log("iterator after EOF", after.length);
  console.log("callback order", order.join(","), warnings);
});
