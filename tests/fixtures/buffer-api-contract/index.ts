import { Buffer, transcode } from "node:buffer";
import { apiChecks } from "./checks.ts";
import assert from "node:assert/strict";

for (const check of apiChecks(Buffer, transcode)) {
  check.run();
  console.log(check.name);
}
const bytes = Buffer.from("123");
const inspect = Reflect.get(bytes, "inspect");
assert.equal(typeof inspect, "function");
assert.equal(Reflect.apply(inspect, bytes, []), Bun.inspect(bytes));
console.log("inspect uses the maintained Buffer formatter");
