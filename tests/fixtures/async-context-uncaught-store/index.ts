// An 'uncaughtException' handler reads the store the callback that threw was started in, as in
// Bun: the callback's own run() has unwound, and the scheduling context is back.
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";

const als = new AsyncLocalStorage<string>();
const seen: Record<string, string> = {};
const sources: Record<string, (boom: () => void) => void> = {
  "process.nextTick": boom => process.nextTick(boom),
  setTimeout: boom => setTimeout(boom, 1),
  setImmediate: boom => setImmediate(boom),
  "fs.readFile callback": boom => fs.readFile(__filename, boom),
  "an EventEmitter listener, emitted from a timer": boom => {
    const emitter = new EventEmitter();
    emitter.on("x", boom);
    setTimeout(() => emitter.emit("x"), 1);
  },
};
const names = Object.keys(sources).flatMap(name => [name + ": throws", name + ": throws inside its own run()"]);
names.push("setTimeout with no store: throws inside its own run()");
process.on("uncaughtException", error => {
  seen[error.message] = String(als.getStore());
  if (Object.keys(seen).length < names.length) return;
  for (const name of names) console.log(name, "->", seen[name]);
  process.exit(0);
});
for (const [name, schedule] of Object.entries(sources)) {
  als.run("outer", () => schedule(() => { throw new Error(name + ": throws"); }));
  als.run("outer", () => schedule(() => als.run("inner", () => { throw new Error(name + ": throws inside its own run()"); })));
}
setTimeout(() => als.run("inner", () => { throw new Error("setTimeout with no store: throws inside its own run()"); }), 1);
